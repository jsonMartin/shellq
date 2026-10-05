#!/usr/bin/env zsh

emulate -LR zsh
setopt no_aliases
unsetopt bg_nice
umask 077

: ${SHELLQ_CODEX_MODEL:=gpt-5.6-luna}
: ${SHELLQ_CODEX_REASONING:=low}

case $SHELLQ_CODEX_REASONING in
  minimal|low|medium|high|xhigh|max|ultra) ;;
  *) exit 64 ;;
esac

typeset output_dir request_file output_file events_file workdir session_file=''
typeset session_dir=''
typeset session_id='' recorded_session_id='' pointer_tmp='' pending_file=''
typeset raw_fifo='' preview_fifo='' normalizer_file=''
typeset -a codex_argv
typeset -i ask_mode=0 persistent_mode=0 resume_mode=0 stream_mode=0
typeset -i child_pid=0 tee_pid=0 jq_pid=0 exit_code=1
typeset -i child_status=1 tee_status=1 jq_status=1 keep_pending=0

if (( ${+SHELLQ_CODEX_WORKDIR} )); then
  ask_mode=1
  workdir=$SHELLQ_CODEX_WORKDIR
fi
# Command and Fix get a private empty cwd below (after output_dir exists), never
# a shared directory whose AGENTS.md another local user could plant.
(( ! ask_mode )) || [[ $workdir == /* && -d $workdir ]] || exit 64
[[ ${SHELLQ_STREAM_PREVIEW:-0} == 1 ]] && stream_mode=1

if (( ask_mode && ${+SHELLQ_CODEX_SESSION_FILE} )); then
  persistent_mode=1
  session_file=$SHELLQ_CODEX_SESSION_FILE
  pending_file=${SHELLQ_ASK_PENDING_FILE:-}
  [[ $session_file == /* ]] || exit 64
  [[ ${SHELLQ_CODEX_NEW_SESSION:-0} == (0|1) ]] || exit 64
  session_dir=${session_file:h}
  if [[ ! -e $session_dir ]]; then
    command mkdir -p -m 700 -- "$session_dir" || exit 1
  fi
  [[ -d $session_dir && ! -L $session_dir ]] || exit 64

  if [[ -e $session_file && ${SHELLQ_CODEX_NEW_SESSION:-0} != 1 ]]; then
    [[ -z $pending_file ]] || exit 64
    [[ -f $session_file && ! -L $session_file ]] || exit 64
    session_id=$(jq -er --arg cwd "$workdir" '
      select(
        .provider == "codex" and
        .cwd == $cwd and
        (.session_id | type == "string") and
        (.session_id | test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"))
      ) | .session_id
    ' "$session_file") || exit 64
    resume_mode=1
  else
    [[
      -n $pending_file &&
      $pending_file == /* &&
      ${pending_file:h} == $session_dir &&
      ${pending_file:t} == ${session_file:t}.pending-* &&
      ${pending_file:t} != ${session_file:t}.pending-
    ]] || exit 64
  fi
elif (( ${+SHELLQ_CODEX_SESSION_FILE} || ${+SHELLQ_CODEX_NEW_SESSION} )); then
  exit 64
fi

output_dir=$(mktemp -d "${TMPDIR:-/tmp}/shellq-codex.XXXXXX") ||
  exit 1
if (( ! ask_mode )); then
  workdir=$output_dir/cwd
  command mkdir -m 700 -- "$workdir" || exit 1
fi
request_file=$output_dir/request.json
output_file=$output_dir/response.json
events_file=$output_dir/events.jsonl
raw_fifo=$output_dir/events.raw.fifo
preview_fifo=$output_dir/events.preview.fifo
normalizer_file=$output_dir/preview.jq

_shellq_provider_cleanup() {
  trap - EXIT HUP INT TERM
  typeset pid
  for pid in $child_pid $tee_pid $jq_pid; do
    (( pid > 0 )) && kill -TERM "$pid" 2>/dev/null
  done
  for pid in $child_pid $tee_pid $jq_pid; do
    (( pid > 0 )) && wait "$pid" 2>/dev/null
  done
  [[ -z $pointer_tmp ]] || command rm -f -- "$pointer_tmp"
  (( keep_pending )) || [[ -z $pending_file ]] || command rm -f -- "$pending_file"
  command rm -f -- \
    "$request_file" "$output_file" "$events_file" \
    "$raw_fifo" "$preview_fifo" "$normalizer_file"
  (( ask_mode )) || command rmdir -- "$output_dir/cwd" 2>/dev/null
  command rmdir -- "$output_dir" 2>/dev/null
}

trap '_shellq_provider_cleanup' EXIT
trap 'keep_pending=0; _shellq_provider_cleanup; exit 129' HUP
trap 'keep_pending=0; _shellq_provider_cleanup; exit 130' INT
trap 'keep_pending=0; _shellq_provider_cleanup; exit 143' TERM

command cat > "$request_file" || exit 1
command jq -e '
  (type == "object") and
  ((has("candidate_count") | not) or .candidate_count == 1 or .candidate_count == 2 or .candidate_count == 3 or .candidate_count == 4 or .candidate_count == 5) and
  ((.mode != "ask") or (has("candidate_count") | not) or .candidate_count == 1)
' "$request_file" >/dev/null 2>&1 || exit 64

if (( resume_mode )); then
  cd -- "$workdir" || exit 64
  codex_argv=(
    codex exec resume
    --ignore-user-config
    --skip-git-repo-check
    -m "$SHELLQ_CODEX_MODEL"
    -c 'sandbox_mode="read-only"'
    -c "model_reasoning_effort=\"$SHELLQ_CODEX_REASONING\""
    --json
    -o "$output_file"
    "$session_id"
    "Read $request_file and return only the JSON response it requests."
  )
else
  codex_argv=(codex exec)
  (( persistent_mode )) || codex_argv+=(--ephemeral)
  (( ask_mode )) || codex_argv+=(-c project_doc_max_bytes=0)
  codex_argv+=(
    --ignore-user-config
    --skip-git-repo-check
    -C "$workdir"
    -s read-only
    -m "$SHELLQ_CODEX_MODEL"
    -c "model_reasoning_effort=\"$SHELLQ_CODEX_REASONING\""
    --json
    -o "$output_file"
    "Read $request_file and return only the JSON response it requests."
  )
fi

if (( stream_mode )); then
  typeset request_mode
  request_mode=$(command jq -er '.mode' "$request_file") || exit 64
  command mkfifo -m 600 -- "$raw_fifo" "$preview_fifo" || exit 1
  command cat >"$normalizer_file" <<'JQ'
def json_like:
  test("^[[:space:]]*(\\{|\\[|```)")
  or test("\"[A-Za-z_][A-Za-z0-9_]*\"[[:space:]]*:");

def structured_preview:
  try fromjson catch null
  | if (type == "object" and (.tldr? | type) == "string") then
      ([{t:"answer", text:("Explanation: " + .tldr)}] +
       (if (.corrected_command? | type) == "string"
        then [{t:"answer", text:("\nCommand: " + .corrected_command)}]
        else [] end))
    elif (type == "object" and (.candidates? | type) == "array") then
      .candidates as $candidates |
      [range(0; $candidates | length) as $index |
        $candidates[$index] |
        select(type == "object" and (.tldr? | type) == "string") |
        ([{t:"answer", text:((if $index == 0 then "" else "\n" end) + "Choice " + (($index + 1) | tostring) + "\nExplanation: " + .tldr)}] +
         (if (.corrected_command? | type) == "string"
          then [{t:"answer", text:("\nCommand: " + .corrected_command)}]
          else [] end))] | add
    else [] end;

if .type == "item.completed" and .item.type == "agent_message" then
  if (.item.text | type) != "string" then
    empty
  elif (.item.text | json_like) then
    if $mode == "ask" then
      {t:"note", text:"Drafting the answer"}
    else
      (.item.text | structured_preview) as $events |
      if ($events | length) > 0 then $events[] else {t:"note", text:"Drafting the answer"} end
    end
  else
    {t:"delta", text:(.item.text[0:1024])}
  end
elif .type == "item.started" and .item.type == "command_execution" then
  {t:"note", text:"Running a read-only command"}
elif .type == "item.started" and .item.type == "web_search" then
  {t:"note", text:"Searching the web"}
elif .type == "item.started" and (.item.type == "mcp_tool_call" or .item.type == "tool_call") then
  {t:"note", text:"Calling a tool"}
else
  empty
end
JQ

  command tee -- "$events_file" <"$raw_fifo" >"$preview_fifo" &
  tee_pid=$!
  command jq -c --unbuffered --arg mode "$request_mode" -f "$normalizer_file" <"$preview_fifo" &
  jq_pid=$!
  command "${codex_argv[@]}" </dev/null >"$raw_fifo" &
  child_pid=$!

  wait "$child_pid"
  child_status=$?
  child_pid=0
  wait "$tee_pid"
  tee_status=$?
  tee_pid=0
  wait "$jq_pid"
  jq_status=$?
  jq_pid=0
  if (( child_status == 0 && tee_status == 0 && jq_status == 0 )); then
    exit_code=0
  fi
else
  command "${codex_argv[@]}" </dev/null >"$events_file" &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  child_pid=0
fi

if (( exit_code == 0 && persistent_mode )) && [[ ! -s $output_file ]]; then
  exit_code=1
fi

if (( exit_code == 0 && persistent_mode )); then
  jq -es -e '
    def not_bidi_control:
      . != 1564
      and . != 8206
      and . != 8207
      and (. < 8234 or . > 8238)
      and (. < 8294 or . > 8297);

    length == 1
    and (
      .[0]
      | type == "object"
      and keys == ["answer"]
      and ((.answer | type) == "string")
      and ((.answer | utf8bytelength) > 0)
      and ((.answer | utf8bytelength) <= 8192)
      and (
        .answer
        | explode
        | all(
            (. == 9 or . == 10 or (. >= 32 and (. < 127 or . > 159)))
            and not_bidi_control
          )
      )
    )
  ' "$output_file" >/dev/null || exit_code=1
fi

if (( exit_code == 0 && persistent_mode )); then
  recorded_session_id=$(jq -ser '
    map(select(
      .type == "thread.started" and
      (.thread_id | type == "string") and
      (.thread_id | test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"))
    )) | first.thread_id
  ' "$events_file") || exit_code=1
  [[ -n $recorded_session_id ]] || exit_code=1
  (( resume_mode == 0 )) || [[ $recorded_session_id == $session_id ]] ||
    exit_code=1
fi

if (( exit_code == 0 && persistent_mode && resume_mode == 0 )); then
  pointer_tmp=$(mktemp "$session_dir/.shellq-codex-session.XXXXXX") ||
    exit_code=1
  if (( exit_code == 0 )) &&
     jq -cn \
       --arg session_id "$recorded_session_id" \
       --arg cwd "$workdir" \
     '{provider:"codex", session_id:$session_id, cwd:$cwd}' \
       >"$pointer_tmp" &&
     command chmod 600 "$pointer_tmp" &&
     command mv -f -- "$pointer_tmp" "$pending_file"; then
    pointer_tmp=''
    keep_pending=1
  else
    exit_code=1
  fi
fi

if (( exit_code == 0 )); then
  if ! command cat -- "$output_file"; then
    exit_code=1
    keep_pending=0
  fi
fi

exit $exit_code
