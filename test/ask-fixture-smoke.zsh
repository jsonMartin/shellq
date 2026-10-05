#!/usr/bin/env zsh

emulate -LR zsh
setopt errexit no_unset pipe_fail

typeset -gr SCRIPT_DIR=${0:A:h}
typeset -gr PROVIDER=${SCRIPT_DIR:h}/src/codex-provider.zsh
typeset -gr STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shellq-ask-fixture.XXXXXX")
typeset -gr FIXTURE=$STATE_DIR/repo
typeset -gr REQUEST=$STATE_DIR/request.json
typeset -gr SESSION_FILE=$STATE_DIR/state/ask.json
typeset -gr PENDING_FILE=$STATE_DIR/state/ask.json.pending-fixture-$$
typeset -gr STREAM_FILE=$STATE_DIR/stream.out
typeset -gr CONVERSATION_TOKEN=ASK-CONTINUATION-731

cleanup() {
  command rm -rf -- "$STATE_DIR"
}
trap cleanup EXIT

command mkdir -p "$FIXTURE"
print -r -- '# Ask fixture

Verification token: UNIVERSAL-ASK-READONLY-731.' > "$FIXTURE/README.md"
print -r -- baseline > "$FIXTURE/tracked.txt"

git -C "$FIXTURE" init -q
git -C "$FIXTURE" add README.md tracked.txt
git -C "$FIXTURE" \
  -c user.name=shellq-fixture \
  -c user.email=fixture@example.invalid \
  commit -q -m baseline

print -r -- 'dirty but read-only' > "$FIXTURE/tracked.txt"
print -r -- 'fixture dirt' > "$FIXTURE/untracked-note.txt"

jq -cn --arg cwd "$FIXTURE" --arg token "$CONVERSATION_TOKEN" '{
  version: 1,
  mode: "ask",
  instructions:
    "Answer the repository question using read-only inspection. Return only the requested JSON object.",
  response_schema: {
    answer:
      "non-empty string, at most 8192 UTF-8 bytes; only printable characters, tabs, and newlines; no bidirectional-formatting characters"
  },
  input: {
    query: (
      "Remember this conversation-only token: " + $token + ". " +
      "Read README.md and Git status. Include the exact fragments tracked.txt: modified and untracked-note.txt: untracked, plus the exact verification token. Do not modify anything."
    ),
    environment: {
      cwd: $cwd,
      shell: "zsh",
      platform: "darwin"
    },
    captured_output: ""
  }
}' > "$REQUEST"

typeset status_before hashes_before response final_response previews
typeset first_session second_session
typeset status_after hashes_after
typeset -i provider_pid=0 provider_status=1 preview_seen_while_running=0
status_before=$(GIT_OPTIONAL_LOCKS=0 git -C "$FIXTURE" \
  status --porcelain=v1 --untracked-files=all)
hashes_before=$(command shasum -a 256 \
  "$FIXTURE/README.md" \
  "$FIXTURE/tracked.txt" \
  "$FIXTURE/untracked-note.txt" \
  "$FIXTURE/.git/index")

SHELLQ_CODEX_WORKDIR="$FIXTURE" \
  SHELLQ_CODEX_SESSION_FILE="$SESSION_FILE" \
  SHELLQ_CODEX_NEW_SESSION=1 \
  SHELLQ_ASK_PENDING_FILE="$PENDING_FILE" \
  SHELLQ_STREAM_PREVIEW=1 \
  GIT_OPTIONAL_LOCKS=0 \
  "$PROVIDER" <"$REQUEST" >"$STREAM_FILE" &
provider_pid=$!
while kill -0 "$provider_pid" 2>/dev/null; do
  if jq -e -s '
    any(.[]; type == "object" and (.t == "delta" or .t == "note"))
  ' "$STREAM_FILE" >/dev/null 2>&1; then
    preview_seen_while_running=1
    break
  fi
  sleep 0.02
done
wait "$provider_pid"
provider_status=$?
(( provider_status == 0 && preview_seen_while_running == 1 ))

response=$(<"$STREAM_FILE")
[[ $response == *$'\n'* ]]
previews=${response%$'\n'*}
final_response=${response##*$'\n'}
print -rn -- "$previews" | jq -es -e '
  length > 0
  and all(.[ ];
    type == "object"
    and (keys == ["t","text"])
    and (.t == "delta" or .t == "note")
    and (.text | type == "string")
    and (
      .t != "note"
      or (.text == "Calling a tool"
          or .text == "Drafting the answer"
          or .text == "Running a read-only command"
          or .text == "Searching the web")
    )
    and (
      .t != "delta"
      or (.text | test("^[[:space:]]*(\\{|\\[|```)" ) | not)
    )
  )
' >/dev/null

print -rn -- "$final_response" | jq -es -e '
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
    and (.answer | contains("UNIVERSAL-ASK-READONLY-731"))
    and (.answer | contains("tracked.txt: modified"))
    and (.answer | contains("untracked-note.txt: untracked"))
  )
' >/dev/null

first_session=$(jq -er \
  --arg cwd "$FIXTURE" \
  'select(
    .provider == "codex"
    and .cwd == $cwd
    and (.session_id | test("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"))
  ) | .session_id' \
  "$PENDING_FILE")
[[ ! -e $SESSION_FILE ]]
command mv -f -- "$PENDING_FILE" "$SESSION_FILE"

jq -cn --arg cwd "$FIXTURE" '{
  version: 1,
  mode: "ask",
  instructions:
    "Answer the repository question using read-only inspection. Return only the requested JSON object.",
  response_schema: {
    answer:
      "non-empty string, at most 8192 UTF-8 bytes; only printable characters, tabs, and newlines; no bidirectional-formatting characters"
  },
  input: {
    query:
      "Repeat the exact conversation-only token from my immediately previous question. It is not in this repository or this request.",
    environment: {
      cwd: $cwd,
      shell: "zsh",
      platform: "darwin"
    },
    captured_output: ""
  }
}' > "$REQUEST"

response=$(SHELLQ_CODEX_WORKDIR="$FIXTURE" \
  SHELLQ_CODEX_SESSION_FILE="$SESSION_FILE" \
  GIT_OPTIONAL_LOCKS=0 \
  "$PROVIDER" < "$REQUEST")

print -rn -- "$response" | jq -es -e --arg token "$CONVERSATION_TOKEN" '
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
    and (.answer | contains($token))
  )
' >/dev/null

second_session=$(jq -er '.session_id' "$SESSION_FILE")
[[ $second_session == "$first_session" ]]

status_after=$(GIT_OPTIONAL_LOCKS=0 git -C "$FIXTURE" \
  status --porcelain=v1 --untracked-files=all)
hashes_after=$(command shasum -a 256 \
  "$FIXTURE/README.md" \
  "$FIXTURE/tracked.txt" \
  "$FIXTURE/untracked-note.txt" \
  "$FIXTURE/.git/index")

[[ $status_after == "$status_before" ]]
[[ $hashes_after == "$hashes_before" ]]

print -r -- 'PASS Ask fixture: preview arrived before final; README and dirty Git state visible; exact Ask session resumed; JSON valid; files and status unchanged'
