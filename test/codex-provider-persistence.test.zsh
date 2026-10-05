#!/usr/bin/env zsh

if [[ ${0:t} == tee ]]; then
  [[ -z ${SHELLQ_FAKE_PIDS:-} ]] || print -r -- "tee:$$" >>"$SHELLQ_FAKE_PIDS"
  if [[ ${SHELLQ_FAKE_FAIL_STAGE:-} == tee ]]; then
    command cat >/dev/null
    exit 17
  fi
  exec "$SHELLQ_REAL_TEE" "$@"
fi

if [[ ${0:t} == jq ]]; then
  [[ -z ${SHELLQ_FAKE_PIDS:-} ]] || print -r -- "jq:$$" >>"$SHELLQ_FAKE_PIDS"
  # Fail only the preview normalizer; request validation also runs jq.
  if [[ ${SHELLQ_FAKE_FAIL_STAGE:-} == jq && " $* " == *" -f "* ]]; then
    command cat >/dev/null
    exit 5
  fi
  exec "$SHELLQ_REAL_JQ" "$@"
fi

if [[ ${0:t} == codex ]]; then
  emulate -LR zsh
  IFS= read -r -t 0.1 unexpected && exit 71
  [[ -z ${SHELLQ_FAKE_PIDS:-} ]] || print -r -- "codex:$$" >>"$SHELLQ_FAKE_PIDS"

  jq -cn --arg pwd "$PWD" --args '{pwd:$pwd,args:$ARGS.positional}' -- "$@" \
    >"$SHELLQ_FAKE_LOG" || exit 72

  typeset output_file=''
  typeset -i index=1
  while (( index <= $# )); do
    if [[ ${argv[index]} == -o ]]; then
      output_file=${argv[index + 1]}
      break
    fi
    (( ++index ))
  done
  [[ -n $output_file ]] || exit 73
  [[ ${SHELLQ_FAKE_FAIL:-0} != 1 ]] || exit 42
  [[ ${SHELLQ_FAKE_FAIL_STAGE:-} != codex ]] || exit 42

  jq -cn --arg id "$SHELLQ_FAKE_THREAD_ID" \
    '{type:"thread.started",thread_id:$id}'
  if [[ ${SHELLQ_FAKE_STREAM_EVENTS:-0} == 1 ]]; then
    print -r -- '{"type":"item.completed","item":{"type":"agent_message","text":"Inspecting safely."}}'
    print -r -- '{"type":"item.started","item":{"type":"command_execution","command":"SECRET-COMMAND-CANARY"}}'
    print -r -- '{"type":"item.started","item":{"type":"web_search","query":"SECRET-QUERY-CANARY"}}'
    print -r -- '{"type":"item.completed","item":{"type":"agent_message","text":"{\"answer\":\"SECRET-FINAL-CANARY\"}"}}'
    print -r -- '{"type":"item.started","item":{"type":"mcp_tool_call","arguments":"SECRET-TOOL-CANARY"}}'
  fi
  if [[ ${SHELLQ_FAKE_SLOW:-0} == 1 ]]; then
    zmodload zsh/zselect || exit 74
    zselect -t 500
  fi
  if [[ ${SHELLQ_FAKE_EMPTY_OUTPUT:-0} != 1 ]]; then
    if [[ ${SHELLQ_FAKE_MALFORMED_OUTPUT:-0} == 1 ]]; then
      print -r -- '{"answer":"probe","extra":true}' >"$output_file"
    else
      print -r -- '{"answer":"probe"}' >"$output_file"
    fi
  fi
  exit
fi

typeset -gr SHELLQ_PROVIDER_PERSISTENCE_TEST_SCRIPT=${0:A}

_shellq_provider_persistence_test() {
emulate -LR zsh
setopt no_aliases pipe_fail
unsetopt bg_nice

typeset -gr TEST_DIR=${SHELLQ_PROVIDER_PERSISTENCE_TEST_SCRIPT:h}
typeset -gr ADAPTER=${TEST_DIR:h}/src/codex-provider.zsh
typeset test_root fake_dir workdir state_dir session_file pending_file response test_tmp
typeset real_tee real_jq
typeset -i provider_status=0 failures=0 checks=0

test_tmp=${TMPDIR:-/tmp}
test_tmp=${test_tmp%/}
test_root=$(mktemp -d "$test_tmp/shellq-provider-persistence.XXXXXX") ||
  exit 1
fake_dir=$test_root/bin
workdir=$test_root/repo
state_dir=$test_root/state
mkdir -p "$fake_dir" "$workdir" "$test_root/tmp" || exit 1
real_tee=$(command -v tee) || exit 1
real_jq=$(command -v jq) || exit 1
export SHELLQ_REAL_TEE=$real_tee
export SHELLQ_REAL_JQ=$real_jq
cp -- "$SHELLQ_PROVIDER_PERSISTENCE_TEST_SCRIPT" "$fake_dir/codex" || exit 1
cp -- "$SHELLQ_PROVIDER_PERSISTENCE_TEST_SCRIPT" "$fake_dir/tee" || exit 1
cp -- "$SHELLQ_PROVIDER_PERSISTENCE_TEST_SCRIPT" "$fake_dir/jq" || exit 1
chmod +x "$fake_dir/codex" "$fake_dir/tee" "$fake_dir/jq" || exit 1
export PATH=$fake_dir:$PATH
export TMPDIR=$test_root/tmp
trap 'rm -rf -- "$test_root"' EXIT

ok() {
  local label=$1
  shift
  (( ++checks ))
  if "$@" >/dev/null; then
    print -r -- "ok $checks - $label"
  else
    print -ru2 -- "not ok $checks - $label"
    (( ++failures ))
  fi
}

all_recorded_pids_gone() {
  local name pid
  while IFS=: read -r name pid; do
    if kill -0 "$pid" 2>/dev/null; then
      print -ru2 -- "$name process $pid is still alive"
      return 1
    fi
  done <"$1"
}

typeset log=$test_root/command.json
response=$(print -rn -- '{"mode":"generate"}' |
  SHELLQ_FAKE_LOG=$log \
  SHELLQ_FAKE_THREAD_ID=unused \
  "$ADAPTER")
provider_status=$?
ok 'Command remains ephemeral and read-only' jq -e \
  --arg tmp "$TMPDIR" '
    (.args | index("-C")) as $cd |
    (.args | index("-s")) as $sandbox |
    .pwd != "" and
    (.args[0:5] == ["exec","--ephemeral","-c","project_doc_max_bytes=0","--ignore-user-config"]) and
    (.args[$cd + 1] | startswith($tmp + "/shellq-codex.") and endswith("/cwd")) and
    (.args[$sandbox + 1] == "read-only") and
    (.args | index("--last") | not)
  ' "$log"
ok 'Command preserves the response contract' test \
  "$provider_status:$response" = '0:{"answer":"probe"}'

session_file=$state_dir/codex.json
pending_file=${session_file}.pending-test-$$
log=$test_root/missing-candidate.json
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_FAKE_LOG=$log \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-0000-7000-8000-000000000000 \
  "$ADAPTER")
provider_status=$?
ok 'New Ask without a request-unique candidate fails closed' test \
  "$provider_status:$response" = '64:'
ok 'Missing candidate is rejected before Codex starts' test ! -e "$log"

log=$test_root/new.json
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_FAKE_LOG=$log \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-1111-7111-8111-111111111111 \
  "$ADAPTER")
provider_status=$?
ok 'New Ask is persistent, cwd-bound, and read-only' jq -e \
  --arg cwd "$workdir" '
    (.args | index("-C")) as $cd |
    (.args | index("-s")) as $sandbox |
    .pwd != "" and
    (.args[0:2] == ["exec","--ignore-user-config"]) and
    (.args | index("--ephemeral") | not) and
    (.args[$cd + 1] == $cwd) and
    (.args[$sandbox + 1] == "read-only") and
    (.args | index("--last") | not)
  ' "$log"
ok 'New Ask stages the exact private session pointer' jq -e \
  --arg cwd "$workdir" '
    . == {provider:"codex",session_id:"0198f3c2-1111-7111-8111-111111111111",cwd:$cwd}
  ' "$pending_file"
ok 'Adapter does not accept its own staged pointer' test ! -e "$session_file"
typeset pointer_mode state_mode
state_mode=$(stat -c '%a' "$state_dir" 2>/dev/null ||
  stat -f '%Lp' "$state_dir" 2>/dev/null)
ok 'First submitted Ask creates its private state directory' test \
  "$state_mode" = 700
pointer_mode=$(stat -c '%a' "$pending_file" 2>/dev/null ||
  stat -f '%Lp' "$pending_file" 2>/dev/null)
ok 'Staged session pointer mode is 0600' test "$pointer_mode" = 600
ok 'New Ask preserves the response contract' test \
  "$provider_status:$response" = '0:{"answer":"probe"}'
mv -f -- "$pending_file" "$session_file" || exit 1

log=$test_root/resume.json
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_FAKE_LOG=$log \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-1111-7111-8111-111111111111 \
  "$ADAPTER")
provider_status=$?
ok 'Ask resumes only the exact stored session from its cwd' jq -e \
  --arg cwd "$workdir" '
    [
      .pwd == $cwd,
      .args[0:3] == ["exec","resume","--ignore-user-config"],
      ((.args | index("0198f3c2-1111-7111-8111-111111111111")) != null),
      (.args | index("--last") | not),
      ((.args | index("sandbox_mode=\"read-only\"")) != null)
    ] | all
  ' "$log"
ok 'Resumed Ask preserves the response contract' test \
  "$provider_status:$response" = '0:{"answer":"probe"}'

log=$test_root/new-session.json
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_FAKE_LOG=$log \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-2222-7222-8222-222222222222 \
  "$ADAPTER")
provider_status=$?
ok 'New-session override starts fresh without ephemeral or resume' jq -e '
  .args[0] == "exec" and
  .args[1] == "--ignore-user-config" and
  (.args | index("resume") | not) and
  (.args | index("--ephemeral") | not) and
  (.args | index("--last") | not)
' "$log"
ok 'Successful new session leaves the accepted pointer unchanged' jq -e \
  '.session_id == "0198f3c2-1111-7111-8111-111111111111"' "$session_file"
ok 'Successful new session stages its replacement' jq -e \
  '.session_id == "0198f3c2-2222-7222-8222-222222222222"' "$pending_file"
mv -f -- "$pending_file" "$session_file" || exit 1

typeset pointer_before
pointer_before=$(<"$session_file")
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_FAKE_LOG=$test_root/fail.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-3333-7333-8333-333333333333 \
  SHELLQ_FAKE_FAIL=1 \
  "$ADAPTER")
provider_status=$?
ok 'Failed new Ask returns the provider status' test "$provider_status" = 42
ok 'Failed new Ask preserves the previous pointer' test \
  "$(<"$session_file")" = "$pointer_before"
ok 'Failed new Ask removes its staged pointer' test ! -e "$pending_file"

response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_FAKE_LOG=$test_root/empty.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-4444-7444-8444-444444444444 \
  SHELLQ_FAKE_EMPTY_OUTPUT=1 \
  "$ADAPTER")
provider_status=$?
ok 'Empty successful output is rejected' test "$provider_status" = 1
ok 'Empty successful output cannot replace the pointer' test \
  "$(<"$session_file")" = "$pointer_before"
ok 'Empty successful output leaves no staged pointer' test ! -e "$pending_file"

response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_FAKE_LOG=$test_root/malformed.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-5555-7555-8555-555555555555 \
  SHELLQ_FAKE_MALFORMED_OUTPUT=1 \
  "$ADAPTER")
provider_status=$?
ok 'Malformed successful output is rejected' test "$provider_status" = 1
ok 'Malformed output cannot replace the pointer' test \
  "$(<"$session_file")" = "$pointer_before"
ok 'Malformed output leaves no staged pointer' test ! -e "$pending_file"

response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_STREAM_PREVIEW=1 \
  SHELLQ_FAKE_STREAM_EVENTS=1 \
  SHELLQ_FAKE_LOG=$test_root/stream.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-2222-7222-8222-222222222222 \
  "$ADAPTER")
provider_status=$?
ok 'Streamed Ask keeps the final response last' test \
  "${response##*$'\n'}" = '{"answer":"probe"}'
ok 'Streamed Ask emits only normalized previews' zsh -c '
  lines=(${(f)1})
  (( ${#lines} == 6 )) || exit 1
  print -r -- "${(F)lines[1,5]}" | jq -e -s \
    '\''map(keys == ["t","text"]) | all'\'' >/dev/null || exit 1
  [[ $1 != *SECRET-* ]]
' -- "$response"
ok 'Streamed resume does not stage or replace its pointer' test \
  ! -e "$pending_file" -a "$(<"$session_file")" = "$pointer_before"

typeset fault pids_file
for fault in codex tee jq; do
  pids_file=$test_root/$fault-pids
  response=$(print -rn -- '{"mode":"ask"}' |
    SHELLQ_CODEX_WORKDIR=$workdir \
    SHELLQ_CODEX_SESSION_FILE=$session_file \
    SHELLQ_CODEX_NEW_SESSION=1 \
    SHELLQ_ASK_PENDING_FILE=$pending_file \
    SHELLQ_STREAM_PREVIEW=1 \
    SHELLQ_FAKE_STREAM_EVENTS=1 \
    SHELLQ_FAKE_FAIL_STAGE=$fault \
    SHELLQ_FAKE_PIDS=$pids_file \
    SHELLQ_REAL_TEE=$real_tee \
    SHELLQ_REAL_JQ=$real_jq \
    SHELLQ_FAKE_LOG=$test_root/$fault.json \
    SHELLQ_FAKE_THREAD_ID=0198f3c2-6666-7666-8666-666666666666 \
    "$ADAPTER")
  provider_status=$?
  ok "$fault failure withholds the final response" test \
    "$provider_status" = 1 -a -z "$response"
  ok "$fault failure reaps every selected process" all_recorded_pids_gone \
    "$pids_file"
  ok "$fault failure removes the staged pointer" test ! -e "$pending_file"
done

typeset early_output=$test_root/early.out
pids_file=$test_root/early-pids
print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_STREAM_PREVIEW=1 \
  SHELLQ_FAKE_STREAM_EVENTS=1 \
  SHELLQ_FAKE_PIDS=$pids_file \
  SHELLQ_FAKE_LOG=$test_root/early.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-8888-7888-8888-888888888888 \
  "$ADAPTER" |
  head -n 1 >"$early_output"
typeset -a early_status=("${pipestatus[@]}")
ok 'Early reader closure makes the adapter fail' test \
  "${early_status[2]}" = 1 -a "${early_status[3]}" = 0
ok 'Early reader receives a preview but never the final' jq -e \
  '.t == "delta" and .text == "Inspecting safely."' "$early_output"
ok 'Early reader closure reaps every selected process' all_recorded_pids_gone \
  "$pids_file"
ok 'Early reader closure removes the staged pointer' test ! -e "$pending_file"

typeset term_output=$test_root/term.out
pids_file=$test_root/term-pids
print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE=$pending_file \
  SHELLQ_STREAM_PREVIEW=1 \
  SHELLQ_FAKE_STREAM_EVENTS=1 \
  SHELLQ_FAKE_SLOW=1 \
  SHELLQ_FAKE_PIDS=$pids_file \
  SHELLQ_REAL_TEE=$real_tee \
  SHELLQ_REAL_JQ=$real_jq \
  SHELLQ_FAKE_LOG=$test_root/term.json \
  SHELLQ_FAKE_THREAD_ID=0198f3c2-7777-7777-8777-777777777777 \
  "$ADAPTER" >"$term_output" &
typeset adapter_pid=$!
typeset -i attempts=0
while [[ ! -s $pids_file && attempts -lt 100 ]]; do
  sleep 0.01
  (( ++attempts ))
done
kill -TERM "$adapter_pid" 2>/dev/null
wait "$adapter_pid"
provider_status=$?
ok 'TERM returns 143 and withholds the final response' test \
  "$provider_status" = 143 -a ! -s "$term_output"
ok 'TERM reaps Codex, tee, and jq' all_recorded_pids_gone "$pids_file"
ok 'TERM removes the staged pointer' test ! -e "$pending_file"
typeset -a leftovers=("$TMPDIR"/shellq-codex.*(N))
ok 'TERM removes its FIFOs and temporary directory' test ${#leftovers} = 0

print -r -- '{"provider":"codex","session_id":"--last","cwd":"wrong"}' \
  >"$session_file"
response=$(print -rn -- '{"mode":"ask"}' |
  SHELLQ_CODEX_WORKDIR=$workdir \
  SHELLQ_CODEX_SESSION_FILE=$session_file \
  SHELLQ_FAKE_LOG=$test_root/invalid.json \
  SHELLQ_FAKE_THREAD_ID=unused \
  "$ADAPTER")
provider_status=$?
ok 'Invalid pointer is rejected before Codex starts' test \
  "$provider_status" = 64 -a ! -e "$test_root/invalid.json"

print -r -- "$(( checks - failures ))/$checks checks passed"
(( failures == 0 ))
}

_shellq_provider_persistence_test "$@"
