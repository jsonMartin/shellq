#!/usr/bin/env zsh

if [[ ${0:t} == codex ]]; then
  emulate -LR zsh

  IFS= read -r -t 0.1 unexpected && exit 71
  if [[ ${SHELLQ_EXPECT_NO_STREAM:-0} == 1 ]]; then
    (( ${+SHELLQ_STREAM_PREVIEW} == 0 )) || exit 78
  fi

  typeset model='' reasoning='' output_file='' prompt='' request_file
  typeset workdir='' sandbox=''
  typeset -i ephemeral=0 ignored_config=0 skipped_git=0 json_output=0
  while (( $# )); do
    case $1 in
      --ephemeral)
        ephemeral=1
        shift
        ;;
      --ignore-user-config)
        ignored_config=1
        shift
        ;;
      --skip-git-repo-check)
        skipped_git=1
        shift
        ;;
      --json)
        json_output=1
        shift
        ;;
      -C)
        workdir=$2
        shift 2
        ;;
      -s)
        sandbox=$2
        shift 2
        ;;
      -m)
        model=$2
        shift 2
        ;;
      -c)
        if [[ $2 == project_doc_max_bytes=0 ]]; then
          project_docs_off=1
        else
          reasoning=$2
        fi
        shift 2
        ;;
      -o)
        output_file=$2
        shift 2
        ;;
      *)
        prompt=$1
        shift
        ;;
    esac
  done

  [[ $model == gpt-5.6-luna ]] || exit 73
  # Ask names its cwd; Command/Fix must get a private empty cwd with no project docs.
  if [[ -n ${SHELLQ_EXPECT_WORKDIR:-} ]]; then
    [[ $workdir == $SHELLQ_EXPECT_WORKDIR ]] || exit 75
  else
    [[ $workdir == ${TMPDIR:-/tmp}/shellq-codex.*/cwd && -d $workdir ]] || exit 75
    (( ${project_docs_off:-0} )) || exit 75
  fi
  [[ $sandbox == read-only ]] || exit 76
  (( ephemeral && ignored_config && skipped_git && json_output )) || exit 77
  [[ $reasoning == \
    "model_reasoning_effort=\"${SHELLQ_CODEX_REASONING:-low}\"" ]] || exit 74
  request_file=${prompt#Read }
  request_file=${request_file% and return only the JSON response it requests.}
  jq -e '.probe == true' "$request_file" >/dev/null || exit 72
  [[ -z ${SHELLQ_CODEX_MARKER:-} ]] ||
    print -r -- $$ > "$SHELLQ_CODEX_MARKER"
  if [[ ${SHELLQ_CODEX_SLOW:-} == 1 ]]; then
    typeset -i sleeper_pid=0
    trap '(( sleeper_pid > 0 )) && kill -TERM "$sleeper_pid" 2>/dev/null; exit 143' \
      HUP INT TERM
    command sleep 30 &
    sleeper_pid=$!
    wait "$sleeper_pid"
    exit $?
  fi
  print -r -- \
    '{"tldr":"probe","corrected_command":"echo probe","confidence":1,"risk":"low"}' \
    > "$output_file"
  exit
fi

emulate -LR zsh
setopt no_aliases pipe_fail
unsetopt bg_nice

typeset -gi TEST_CHECKS=0
typeset -gi TEST_FAILURES=0
typeset -gi TEST_EXECUTIONS=0
typeset -ga TEST_ZLE_CALLS=()
typeset -g TEST_RAW='find ? ! -path (literal) | head'
typeset -ga SHELLQ_PROVIDER=(_mock_provider)

_pass() {
  (( ++TEST_CHECKS ))
  print -r -- "ok $TEST_CHECKS - $1"
}

_fail() {
  (( ++TEST_CHECKS, ++TEST_FAILURES ))
  print -ru2 -- "not ok $TEST_CHECKS - $1${2:+: $2}"
}

_expect_ok() {
  local label=$1
  shift
  if "$@"; then
    _pass "$label"
  else
    _fail "$label"
  fi
}

_expect_fail() {
  local label=$1
  shift
  if "$@"; then
    _fail "$label" 'unexpected success'
  else
    _pass "$label"
  fi
}

_expect_eq() {
  local label=$1 expected=$2 actual=$3
  if [[ $actual == "$expected" ]]; then
    _pass "$label"
  else
    _fail "$label" "expected ${(qqq)expected}, got ${(qqq)actual}"
  fi
}

_mock_provider() {
  emulate -L zsh
  (( ${+SHELLQ_STREAM_PREVIEW} == 0 )) || return 45
  local request
  request=$(command cat)
  jq -e --arg expected "$TEST_RAW" \
    '.mode == "generate" and .input.command == $expected' \
    <<< "$request" >/dev/null || return 41
  jq -cn '{
    tldr: "generated",
    corrected_command: "_would_execute",
    confidence: 1,
    risk: "low"
  }'
}

_oversized_provider() {
  command cat >/dev/null
  jq -cn --arg command "echo ${(l:128::x:)}" '{
    tldr: "generated",
    corrected_command: $command,
    confidence: 1,
    risk: "low"
  }'
}

_trailing_provider() {
  command cat >/dev/null
  print -rn -- \
    '{"tldr":"x","corrected_command":"pwd","confidence":1,"risk":"x"}'
  repeat 201; do print
  done
}

_status_spoof_provider() {
  command cat >/dev/null
  print -rn -- \
    '{"tldr":"x","corrected_command":"pwd","confidence":1,"risk":"x"}'
  print -r -- 0 2>/dev/null >&3 || true
  return 9
}

_would_execute() {
  (( ++TEST_EXECUTIONS ))
}

zle() {
  TEST_ZLE_CALLS+=("${(j: :)@}")
  return 0
}

typeset -gr TEST_DIR=${0:A:h}
typeset -gr TEST_PLUGIN=${TEST_DIR:h}/shellq.plugin.zsh

unset SHELLQ_CODEX_MODEL SHELLQ_CLAUDE_MODELS
_expect_ok 'plugin syntax' zsh -n "$TEST_PLUGIN"
if source "$TEST_PLUGIN"; then
  _pass 'plugin loads'
else
  _fail 'plugin loads'
  print -ru2 -- "FAIL $TEST_FAILURES/$TEST_CHECKS checks"
  exit 1
fi
_expect_eq 'mock provider preserved on load' _mock_provider "$SHELLQ_PROVIDER[1]"
_expect_eq 'Luna is the bundled Codex default' \
  gpt-5.6-luna "$SHELLQ_CODEX_MODEL"
_expect_eq 'Claude fallback exposes Fable, Opus, and Sonnet' \
  claude-fable-5,claude-opus-5,claude-sonnet-5 "$SHELLQ_CLAUDE_MODELS"
_expect_eq 'App Server process reuse is enabled by default' \
  1 "$SHELLQ_APP_SERVER_REUSE"
typeset default_provider
default_provider=$(zsh -fc \
  'source "$1"; print -r -- "$SHELLQ_PROVIDER[1]"' \
  _ "$TEST_PLUGIN")
_expect_eq 'bundled provider defaults to the shared executable adapter' \
  "${TEST_DIR:h}/src/codex-provider.zsh" "$default_provider"

typeset second_copy=${$(mktemp -d):A} reloaded
cp "$TEST_PLUGIN" "$second_copy/shellq.plugin.zsh"
ln -s "${TEST_DIR:h}/src" "$second_copy/src"
reloaded=$(zsh -fc \
  'source "$1"; source "$2/shellq.plugin.zsh"; print -r -- "$SHELLQ_PROVIDER[1] $SHELLQ_WORKBENCH_COMMAND[2]"' \
  _ "$TEST_PLUGIN" "$second_copy")
_expect_eq 'a ShellQ copy loaded later uses its own provider and workbench' \
  "$second_copy/src/codex-provider.zsh $second_copy/src/workbench.ts" "$reloaded"
reloaded=$(zsh -fc \
  'SHELLQ_WORKBENCH_COMMAND=(my-workbench); source "$1"; source "$2/shellq.plugin.zsh"; print -r -- "$SHELLQ_WORKBENCH_COMMAND"' \
  _ "$TEST_PLUGIN" "$second_copy")
_expect_eq 'a user workbench command survives loading two ShellQ copies' \
  my-workbench "$reloaded"
rm -rf "$second_copy"

_expect_eq 'duration rounds just below one minute' \
  59.9s "$(_shellq_format_duration 59.94)"
_expect_eq 'duration rounds at one minute' \
  '1m 0.0s' "$(_shellq_format_duration 59.95)"
_expect_eq 'duration rounds just above one minute' \
  '1m 0.0s' "$(_shellq_format_duration 59.96)"
_expect_eq 'duration preserves exact one minute' \
  '1m 0.0s' "$(_shellq_format_duration 60)"
_expect_eq 'duration preserves 59 minutes 59.9 seconds' \
  '59m 59.9s' "$(_shellq_format_duration 3599.9)"
_expect_eq 'duration rounds just below one hour' \
  '59m 59.9s' "$(_shellq_format_duration 3599.94)"
_expect_eq 'duration rounds at one hour' \
  '1h 0m 0.0s' "$(_shellq_format_duration 3599.95)"
_expect_eq 'duration rounds just above one hour' \
  '1h 0m 0.0s' "$(_shellq_format_duration 3599.96)"
_expect_eq 'duration preserves exact one hour' \
  '1h 0m 0.0s' "$(_shellq_format_duration 3600)"
_expect_eq 'duration preserves hours minutes and tenths' \
  '1h 1m 1.2s' "$(_shellq_format_duration 3661.2)"

typeset codex_probe_dir codex_probe_output codex_probe_marker saved_path
typeset -i codex_reasoning_status=1
codex_probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/shellq-codex-probe.XXXXXX")
if [[ -n $codex_probe_dir ]] &&
   command cp -- "${0:A}" "$codex_probe_dir/codex" &&
   command chmod +x "$codex_probe_dir/codex"; then
  saved_path=$PATH
  PATH=$codex_probe_dir:$PATH
  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_EXPECT_NO_STREAM=1 _shellq_codex_provider)
  typeset -i codex_probe_status=$?
  _expect_eq 'bundled Codex adapter closes its stdin' 0 "$codex_probe_status"
  _expect_ok 'bundled Codex adapter returns the request-file response' \
    _shellq_response_valid "$codex_probe_output" 1
  SHELLQ_CODEX_REASONING=medium
  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_EXPECT_NO_STREAM=1 _shellq_codex_provider)
  codex_probe_status=$?
  codex_reasoning_status=$codex_probe_status
  SHELLQ_CODEX_REASONING=low

  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_CODEX_WORKDIR="$codex_probe_dir" \
    SHELLQ_EXPECT_WORKDIR="$codex_probe_dir" \
    "$default_provider")
  codex_probe_status=$?
  _expect_eq 'bundled Codex adapter forwards a validated Ask workdir' \
    0 "$codex_probe_status"

  codex_probe_marker=$codex_probe_dir/invoked
  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_CODEX_WORKDIR=relative/path \
    SHELLQ_CODEX_MARKER="$codex_probe_marker" \
    "$default_provider")
  codex_probe_status=$?
  _expect_eq 'bundled Codex adapter rejects a relative workdir' \
    64 "$codex_probe_status"
  _expect_ok 'relative workdir is rejected before Codex starts' \
    test ! -e "$codex_probe_marker"

  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_CODEX_WORKDIR=/definitely/missing/shellq-workdir \
    SHELLQ_CODEX_MARKER="$codex_probe_marker" \
    "$default_provider")
  codex_probe_status=$?
  _expect_eq 'bundled Codex adapter rejects a missing workdir' \
    64 "$codex_probe_status"
  _expect_ok 'missing workdir is rejected before Codex starts' \
    test ! -e "$codex_probe_marker"

  codex_probe_output=$(print -rn -- '{"probe":true}' |
    SHELLQ_CODEX_WORKDIR='' \
    SHELLQ_CODEX_MARKER="$codex_probe_marker" \
    "$default_provider")
  codex_probe_status=$?
  _expect_eq 'bundled Codex adapter rejects an empty supplied workdir' \
    64 "$codex_probe_status"
  _expect_ok 'empty workdir is rejected before Codex starts' \
    test ! -e "$codex_probe_marker"

  typeset -i codex_adapter_pid=0 codex_child_pid=0 codex_cancel_status=0
  print -rn -- '{"probe":true}' |
    SHELLQ_CODEX_SLOW=1 \
    SHELLQ_CODEX_MARKER="$codex_probe_marker" \
    "$default_provider" >/dev/null &
  codex_adapter_pid=$!
  repeat 60; do
    [[ -s $codex_probe_marker ]] && break
    command sleep 0.05
  done
  if [[ -s $codex_probe_marker ]]; then
    codex_child_pid=$(<"$codex_probe_marker")
    _pass 'bundled adapter started its cancellable Codex child'
  else
    _fail 'bundled adapter started its cancellable Codex child'
  fi
  kill -TERM "$codex_adapter_pid" 2>/dev/null
  wait "$codex_adapter_pid" 2>/dev/null
  codex_cancel_status=$?
  _expect_eq 'terminating the adapter returns cancellation status' \
    143 "$codex_cancel_status"
  repeat 40; do
    (( codex_child_pid > 0 )) && kill -0 "$codex_child_pid" 2>/dev/null ||
      break
    command sleep 0.05
  done
  _expect_fail 'adapter cancellation leaves no Codex child' \
    kill -0 "$codex_child_pid"
  command rm -f -- "$codex_probe_marker"
  PATH=$saved_path
  _expect_eq 'bundled Codex adapter forwards configured reasoning' \
    0 "$codex_reasoning_status"
else
  _fail 'bundled Codex adapter probe starts'
fi
command rm -f -- "$codex_probe_dir/codex"
command rmdir -- "$codex_probe_dir" 2>/dev/null

typeset request ask_request analysis_request actual
request=$(_shellq_request_json generate "$TEST_RAW" '' '' '' false)
actual=$(jq -r '.input.command' <<< "$request")
_expect_eq 'raw metacharacters survive request JSON' "$TEST_RAW" "$actual"
if jq -e '
  .response_schema == {
    tldr:
      "non-empty string, at most 500 characters, no control or bidirectional-formatting characters",
    corrected_command:
      "string or null; at most 8192 characters; only printable characters, tabs, and newlines; no bidirectional-formatting characters",
    confidence: "number from 0 to 1",
    risk:
      "non-empty string, at most 80 characters, no control or bidirectional-formatting characters"
  }
' <<< "$request" >/dev/null; then
  _pass 'request advertises all validator bounds'
else
  _fail 'request advertises all validator bounds'
fi
ask_request=$(_shellq_ask_request_json)
if jq -e --arg cwd "$PWD" '
  .mode == "ask"
  and .input.query == ""
  and .input.environment.cwd == $cwd
  and .input.captured_output == ""
  and .response_schema == {
    answer:
      "non-empty string, at most 8192 UTF-8 bytes; only printable characters, tabs, and newlines; no bidirectional-formatting characters"
  }
' <<< "$ask_request" >/dev/null; then
  _pass 'Ask request has a separate bounded response contract'
else
  _fail 'Ask request has a separate bounded response contract'
fi
analysis_request=$(_shellq_request_json analyze \
  'cd /unknown' 1 '1' 'cd: no such file or directory: /unknown' true)
actual=$(jq -r '.instructions' <<< "$analysis_request")
if [[ $actual == *'Never guess missing paths or arguments'* ]]; then
  _pass 'analysis request prohibits guessed corrections'
else
  _fail 'analysis request prohibits guessed corrections'
fi

sleep 30 &
typeset -i unrelated_pid=$!
typeset -i helper_fd=-1 helper_status_fd=-1 helper_pid=0 helper_status=0
typeset helper_output
if _shellq_start_provider pid_check "$request"; then
  helper_fd=${_SHELLQ_PROVIDER_FDS[pid_check]}
  helper_status_fd=${_SHELLQ_PROVIDER_STATUS_FDS[pid_check]}
  helper_pid=${_SHELLQ_PROVIDER_PIDS[pid_check]}
  unset '_SHELLQ_PROVIDER_FDS[pid_check]' \
    '_SHELLQ_PROVIDER_STATUS_FDS[pid_check]' \
    '_SHELLQ_PROVIDER_PIDS[pid_check]'
  helper_output=$(command cat <&$helper_fd)
  exec {helper_fd}<&-
  IFS= read -ru "$helper_status_fd" helper_status || helper_status=1
  exec {helper_status_fd}<&-
  if (( helper_pid > 0 && helper_pid != unrelated_pid )); then
    _pass 'provider wrapper PID is not an unrelated background job'
  else
    _fail 'provider wrapper PID is not an unrelated background job'
  fi
  _expect_eq 'provider wrapper exposes its real exit status' 0 "$helper_status"
  _expect_ok 'provider wrapper returns one valid response' \
    _shellq_response_valid "$helper_output" 1
  _expect_ok 'provider wrapper leaves unrelated background job alive' \
    kill -0 "$unrelated_pid"
else
  _fail 'provider wrapper starts through a private FIFO'
fi
kill "$unrelated_pid" 2>/dev/null
wait "$unrelated_pid" 2>/dev/null

SHELLQ_PROVIDER=(_status_spoof_provider)
typeset -i spoof_fd=-1 spoof_status_fd=-1 spoof_status=0
if _shellq_start_provider status_spoof "$request"; then
  spoof_fd=${_SHELLQ_PROVIDER_FDS[status_spoof]}
  spoof_status_fd=${_SHELLQ_PROVIDER_STATUS_FDS[status_spoof]}
  unset '_SHELLQ_PROVIDER_FDS[status_spoof]' \
    '_SHELLQ_PROVIDER_STATUS_FDS[status_spoof]' \
    '_SHELLQ_PROVIDER_PIDS[status_spoof]'
  command cat <&$spoof_fd >/dev/null
  exec {spoof_fd}<&-
  IFS= read -ru "$spoof_status_fd" spoof_status || spoof_status=1
  exec {spoof_status_fd}<&-
  _expect_eq 'provider cannot forge its trusted exit status' 9 "$spoof_status"
else
  _fail 'provider starts for status-channel isolation check'
fi
SHELLQ_PROVIDER=(_mock_provider)

BUFFER=$TEST_RAW
CURSOR=${#BUFFER}
if _shellq_inline_generate; then
  _pass 'inline widget accepts structured mock response'
else
  _fail 'inline widget accepts structured mock response'
fi
_expect_eq 'inline widget inserts but does not execute' _would_execute "$BUFFER"
_expect_eq 'inline widget positions cursor at end' "${#BUFFER}" "$CURSOR"
_expect_eq 'generated command was not executed' 0 "$TEST_EXECUTIONS"

typeset -i saved_response_max=$SHELLQ_RESPONSE_MAX_BYTES
SHELLQ_PROVIDER=(_oversized_provider)
SHELLQ_RESPONSE_MAX_BYTES=32
BUFFER=$TEST_RAW
CURSOR=${#BUFFER}
_expect_fail 'oversized inline response is rejected' _shellq_inline_generate
_expect_eq 'oversized response leaves the buffer unchanged' "$TEST_RAW" "$BUFFER"
SHELLQ_PROVIDER=(_trailing_provider)
SHELLQ_RESPONSE_MAX_BYTES=100
BUFFER=$TEST_RAW
CURSOR=${#BUFFER}
_expect_fail 'raw trailing bytes count toward the inline response cap' \
  _shellq_inline_generate
_expect_eq 'trailing-byte overflow leaves the buffer unchanged' \
  "$TEST_RAW" "$BUFFER"
SHELLQ_PROVIDER=(_mock_provider)
SHELLQ_RESPONSE_MAX_BYTES=$saved_response_max

typeset valid null_valid missing_risk bad_confidence bad_control bad_stream
typeset bad_bidi_command bad_bidi_tldr bad_bidi_risk
typeset max_risk overlong_risk
valid=$(jq -cn '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: "low"
}')
null_valid=$(jq -cn '{
  tldr: "no safe one-liner",
  corrected_command: null,
  confidence: 0.4,
  risk: "high"
}')
missing_risk=$(jq -cn '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8
}')
bad_confidence=$(jq -cn '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 2,
  risk: "low"
}')
bad_control=$(jq -cn --arg command $'echo \e[31munsafe' '{
  tldr: "fix it",
  corrected_command: $command,
  confidence: 0.8,
  risk: "low"
}')
bad_c1_control=$(jq -cn --arg command $'echo \u009b2Junsafe' '{
  tldr: "fix it",
  corrected_command: $command,
  confidence: 0.8,
  risk: "low"
}')
bad_c1_risk=$(jq -cn --arg risk $'\u009b2J' '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: $risk
}')
bad_bidi_command=$(jq -cn --arg command $'echo \u202ereordered' '{
  tldr: "fix it",
  corrected_command: $command,
  confidence: 0.8,
  risk: "low"
}')
bad_bidi_tldr=$(jq -cn --arg tldr $'\u2066isolated' '{
  tldr: $tldr,
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: "low"
}')
bad_bidi_risk=$(jq -cn --arg risk $'\u202ereordered' '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: $risk
}')
bad_stream=$bad_control$'\n'$valid
max_risk=$(jq -cn --arg risk "${(l:80::x:)}" '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: $risk
}')
overlong_risk=$(jq -cn --arg risk "${(l:81::x:)}" '{
  tldr: "fix it",
  corrected_command: "echo fixed",
  confidence: 0.8,
  risk: $risk
}')
_expect_ok 'valid structured response accepted' \
  _shellq_response_valid "$valid" 1
_expect_ok '80-character risk accepted' \
  _shellq_response_valid "$max_risk" 1
_expect_fail '81-character risk rejected' \
  _shellq_response_valid "$overlong_risk" 1
_expect_ok 'null correction accepted for analysis' \
  _shellq_response_valid "$null_valid" 0
_expect_fail 'null correction rejected for generation' \
  _shellq_response_valid "$null_valid" 1
_expect_fail 'missing structured field rejected' \
  _shellq_response_valid "$missing_risk" 0
_expect_fail 'out-of-range confidence rejected' \
  _shellq_response_valid "$bad_confidence" 0
_expect_fail 'control bytes in correction rejected' \
  _shellq_response_valid "$bad_control" 0
_expect_fail 'C1 control bytes in correction rejected' \
  _shellq_response_valid "$bad_c1_control" 0
_expect_fail 'C1 control bytes in response text rejected' \
  _shellq_response_valid "$bad_c1_risk" 0
_expect_fail 'bidi override in correction rejected' \
  _shellq_response_valid "$bad_bidi_command" 0
_expect_fail 'bidi isolate in response text rejected' \
  _shellq_response_valid "$bad_bidi_tldr" 0
_expect_fail 'bidi override in risk rejected' \
  _shellq_response_valid "$bad_bidi_risk" 0
_expect_fail 'multiple response objects are rejected as one malformed stream' \
  _shellq_response_valid "$bad_stream" 0

typeset dirty clean long bounded
dirty=$'old \e[31mred\e[0m\x01\nosc \e]0;secret\aend\nlast'
clean=$(_shellq_sanitize_snapshot "$dirty" 10 256)
_expect_eq 'ANSI and control sequences stripped' $'old red\nosc end\nlast' "$clean"
clean=$(_shellq_sanitize_snapshot $'old\u009b2Jlast' 10 256)
_expect_eq 'C1 terminal controls are stripped' 'old2Jlast' "$clean"
clean=$(_shellq_sanitize_snapshot $'one\ntwo\nthree' 2 256)
_expect_eq 'snapshot line cap keeps newest lines' $'two\nthree' "$clean"
long=''
repeat 100; do long+=x; done
bounded=$(_shellq_sanitize_snapshot "$long" 1 16)
if (( ${#bounded} <= 16 )); then
  _pass 'snapshot byte cap is enforced'
else
  _fail 'snapshot byte cap is enforced' "${#bounded} bytes retained"
fi

herdr() {
  [[ $1 == pane && $2 == read &&
     $4 == --source && $5 == recent-unwrapped &&
     $6 == --lines && $7 == 7 &&
     $8 == --format && $9 == text ]] || return 64
  case $3 in
    pane-A) print -r -- herdr-snapshot ;;
    pane-old)
      [[ $HERDR_SOCKET_PATH == /tmp/socket-old ]] || return 65
      print -r -- stored-herdr-snapshot
      ;;
    *) return 66 ;;
  esac
}

tmux() {
  [[ $1 == capture-pane && $2 == -p && $3 == -S && $4 == -7 ]] || return 64
  print -r -- tmux-snapshot
}

typeset snapshot
HERDR_PANE_ID=pane-A
TMUX=mock
snapshot=$(_ai_pane_snapshot 7)
_expect_eq 'Herdr pane capability wins over tmux' herdr-snapshot "$snapshot"

typeset saved_start_provider=${functions[_shellq_start_provider]}
typeset -i saved_capture_lines=$SHELLQ_CAPTURE_LINES
typeset TEST_ANALYSIS_REQUEST=''
_shellq_start_provider() {
  TEST_ANALYSIS_REQUEST=$2
  return 1
}
_SHELLQ_LAST_COMMAND='gti status'
_SHELLQ_LAST_CWD=$PWD
_SHELLQ_LAST_STATUS=127
_SHELLQ_LAST_PIPESTATUS=(127)
_SHELLQ_LAST_PID=$$
_SHELLQ_LAST_HERDR_SOCKET_PATH=/tmp/socket-old
_SHELLQ_LAST_HERDR_PANE_ID=pane-old
_SHELLQ_LAST_SEQUENCE=77
HERDR_SOCKET_PATH=/tmp/socket-new
HERDR_PANE_ID=pane-new
SHELLQ_CAPTURE_LINES=7
_shellq_analyze_failure >/dev/null 2>&1
SHELLQ_CAPTURE_LINES=$saved_capture_lines
functions[_shellq_start_provider]=$saved_start_provider
actual=$(jq -r '.input.captured_output' <<< "$TEST_ANALYSIS_REQUEST")
_expect_eq 'analysis captures the failed command pane, not the current pane' \
  stored-herdr-snapshot "$actual"
actual=$(jq -r '.input.identity.herdr_pane_id' <<< "$TEST_ANALYSIS_REQUEST")
_expect_eq 'analysis request keeps the failed command pane identity' \
  pane-old "$actual"

unset HERDR_PANE_ID HERDR_SOCKET_PATH
snapshot=$(_ai_pane_snapshot 7)
_expect_eq 'tmux is the second snapshot capability' tmux-snapshot "$snapshot"
unset TMUX
snapshot=$(_ai_pane_snapshot 7)
_expect_eq 'snapshot degrades to empty output' '' "$snapshot"

_capture_tier2_hint() {
  local exit_code=$1 command=$2 threshold=$3 hint_file
  hint_file=$(mktemp "${TMPDIR:-/tmp}/shellq-hint.XXXXXX") || return 1
  SHELLQ_LONG_COMMAND_SECONDS=$threshold
  _shellq_preexec "$command"
  ( exit "$exit_code" )
  _shellq_precmd 2> "$hint_file"
  REPLY=$(<"$hint_file")
  command rm -f -- "$hint_file"
}

typeset hint
_capture_tier2_hint 127 missing-command 999999
hint=$REPLY
_expect_eq 'status 127 emits one local hint' \
  $'\e[2mshellq: command not found — Ctrl-O to fix\e[0m' "$hint"
_capture_tier2_hint 126 ./not-executable 999999
hint=$REPLY
_expect_eq 'status 126 emits one local hint' \
  $'\e[2mshellq: command is not executable — Ctrl-O to fix\e[0m' "$hint"
_capture_tier2_hint 130 interrupted 999999
hint=$REPLY
_expect_eq 'status 130 emits one local hint' \
  $'\e[2mshellq: interrupted with ^C\e[0m' "$hint"
_capture_tier2_hint 0 completed-command 0
hint=$REPLY
typeset -a hint_lines=( "${(@f)hint}" )
if (( ${#hint_lines} == 1 )) && [[ $hint == *'shellq: completed in '*s* ]]; then
  _pass 'long command emits one local hint'
else
  _fail 'long command emits one local hint' ${(qqq)hint}
fi
_expect_eq 'Tier-2 hints do not start AI analysis' -1 \
  "$_SHELLQ_ANALYSIS_FD"

SHELLQ_LONG_COMMAND_SECONDS=999999
HERDR_SOCKET_PATH=/tmp/shellq-test.sock
HERDR_PANE_ID=pane-life
typeset life_command='missing --bad | helper'
typeset life_cwd=$PWD
_shellq_preexec "$life_command"
typeset -i life_sequence=$_SHELLQ_SEQUENCE
true | false
_shellq_precmd >/dev/null 2>&1

_expect_eq 'lifecycle preserves raw command' "$life_command" "$_SHELLQ_LAST_COMMAND"
_expect_eq 'lifecycle preserves cwd' "$life_cwd" "$_SHELLQ_LAST_CWD"
_expect_eq 'lifecycle preserves exit status' 1 "$_SHELLQ_LAST_STATUS"
_expect_eq 'lifecycle preserves pipeline statuses' 0,1 \
  "${(j:,:)_SHELLQ_LAST_PIPESTATUS}"
_expect_eq 'lifecycle preserves shell PID' "$$" "$_SHELLQ_LAST_PID"
_expect_eq 'lifecycle preserves Herdr socket' "$HERDR_SOCKET_PATH" \
  "$_SHELLQ_LAST_HERDR_SOCKET_PATH"
_expect_eq 'lifecycle preserves Herdr pane' "$HERDR_PANE_ID" \
  "$_SHELLQ_LAST_HERDR_PANE_ID"
_expect_eq 'lifecycle preserves sequence' "$life_sequence" \
  "$_SHELLQ_LAST_SEQUENCE"

request=$(_shellq_request_json \
  correct \
  "$_SHELLQ_LAST_COMMAND" \
  "$_SHELLQ_LAST_STATUS" \
  "${(j:,:)_SHELLQ_LAST_PIPESTATUS}" \
  'stderr detail' \
  true)
if jq -e \
  --arg cwd "$life_cwd" \
  --arg socket "$HERDR_SOCKET_PATH" \
  --arg pane "$HERDR_PANE_ID" \
  --argjson pid "$$" \
  --argjson sequence "$life_sequence" '
    .input.exit_status == 1
    and .input.pipeline_statuses == [0, 1]
    and .input.cwd == $cwd
    and .input.identity.shell_pid == $pid
    and .input.identity.herdr_socket_path == $socket
    and .input.identity.herdr_pane_id == $pane
    and .input.identity.sequence == $sequence
    and .input.captured_output_is_untrusted == true
  ' <<< "$request" >/dev/null; then
  _pass 'correction request carries lifecycle identity'
else
  _fail 'correction request carries lifecycle identity'
fi

request=$(_shellq_request_json \
  correct \
  "$_SHELLQ_LAST_COMMAND" \
  "$_SHELLQ_LAST_STATUS" \
  "${(j:,:)_SHELLQ_LAST_PIPESTATUS}" \
  '' \
  false)
if jq -e '
  .input.command != ""
  and .input.exit_status == 1
  and .input.captured_output == ""
  and .input.captured_output_correlated_to_command == false
' <<< "$request" >/dev/null; then
  _pass 'empty pane output retains useful failure context'
else
  _fail 'empty pane output retains useful failure context'
fi

BUFFER=''
CURSOR=0
_shellq_clear_pending
_SHELLQ_ANALYSIS_STARTED_AT=$EPOCHREALTIME
_SHELLQ_ANALYSIS_SEQUENCE=$_SHELLQ_LAST_SEQUENCE
_SHELLQ_ANALYSIS_SHELL_PID=$$
_SHELLQ_ANALYSIS_HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH
_SHELLQ_ANALYSIS_HERDR_PANE_ID=$HERDR_PANE_ID
_expect_ok 'valid analysis result populates pending state' \
  _shellq_finish_analysis 0 "$valid"
_expect_eq 'valid analysis exposes its correction for review' \
  'echo fixed' "$_SHELLQ_PENDING_CORRECTION"

_shellq_clear_pending
_SHELLQ_ANALYSIS_STARTED_AT=$EPOCHREALTIME
_expect_fail 'malformed analysis result is discarded' \
  _shellq_finish_analysis 0 "$missing_risk"
_expect_eq 'malformed analysis cannot populate pending state' \
  '' "$_SHELLQ_PENDING_CORRECTION"

_SHELLQ_ANALYSIS_STARTED_AT=$(( EPOCHREALTIME - SHELLQ_PENDING_TIMEOUT - 1 ))
_expect_fail 'stale valid analysis result is discarded' \
  _shellq_finish_analysis 0 "$valid"
_expect_eq 'stale analysis cannot populate pending state' \
  '' "$_SHELLQ_PENDING_CORRECTION"

_seed_pending() {
  _SHELLQ_PENDING_CORRECTION=_would_execute
  _SHELLQ_PENDING_CREATED_AT=$EPOCHREALTIME
  _SHELLQ_PENDING_SEQUENCE=$_SHELLQ_LAST_SEQUENCE
  _SHELLQ_PENDING_SHELL_PID=$$
  _SHELLQ_PENDING_HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH
  _SHELLQ_PENDING_HERDR_PANE_ID=$HERDR_PANE_ID
  _SHELLQ_PENDING_BUFFER=''
  _SHELLQ_PENDING_CURSOR=0
}

_seed_pending
_expect_ok 'matching pending result is fresh' _shellq_pending_is_fresh
_SHELLQ_PENDING_HERDR_PANE_ID=other-pane
_expect_fail 'mismatched pending pane is rejected' _shellq_pending_is_fresh
_seed_pending
_SHELLQ_PENDING_CREATED_AT=$(( EPOCHREALTIME - SHELLQ_PENDING_TIMEOUT - 1 ))
_expect_fail 'stale pending result is rejected' _shellq_pending_is_fresh
_seed_pending
(( ++_SHELLQ_PENDING_SEQUENCE ))
_expect_fail 'mismatched pending sequence is rejected' _shellq_pending_is_fresh

_seed_pending
BUFFER=''
CURSOR=0
TEST_ZLE_CALLS=()
if _shellq_accept_or_complete; then
  _pass 'Tab accepts a fresh correction on untouched prompt'
else
  _fail 'Tab accepts a fresh correction on untouched prompt'
fi
_expect_eq 'Tab inserts correction without execution' _would_execute "$BUFFER"
_expect_eq 'accepted correction cursor is at end' "${#BUFFER}" "$CURSOR"
_expect_eq 'Tab acceptance never executes correction' 0 "$TEST_EXECUTIONS"

_seed_pending
BUFFER='typed'
CURSOR=${#BUFFER}
_SHELLQ_TAB_PRIOR[emacs]=_prior_tab
TEST_ZLE_CALLS=()
_shellq_accept_or_complete
_expect_eq 'typed prompt delegates to prior Tab widget' _prior_tab \
  "${TEST_ZLE_CALLS[-1]-}"
_expect_eq 'delegated Tab leaves typed buffer unchanged' typed "$BUFFER"

_seed_pending
BUFFER='typed'
CURSOR=${#BUFFER}
KEYMAP=main
_SHELLQ_TAB_PRIOR[main]=_prior_vi_tab
TEST_ZLE_CALLS=()
_shellq_accept_or_complete
_expect_eq 'main keymap delegates to its prior vi-mode Tab widget' \
  _prior_vi_tab "${TEST_ZLE_CALLS[-1]-}"
unset KEYMAP

typeset saved_progressive_herdr=${functions[herdr]}
typeset saved_progressive_tmux=${functions[tmux]}
typeset capture_log capture_context capture_source capture_label capture_calls
typeset -i TEST_CAPTURE_MATCH_AT=160
typeset TEST_CAPTURE_NEEDLE='deploy --dry-run'
capture_log=$(mktemp "${TMPDIR:-/tmp}/shellq-capture.XXXXXX")
typeset TEST_CAPTURE_LOG=$capture_log

herdr() {
  print -r -- "$7" >> "$TEST_CAPTURE_LOG"
  if (( $7 >= TEST_CAPTURE_MATCH_AT )); then
    print -r -- "older
$TEST_CAPTURE_NEEDLE
newer"
  else
    print -r -- recent-output
  fi
}
tmux() {
  return 1
}

_expect_ok 'progressive capture finds the recorded command' \
  _shellq_progressive_capture \
  "$TEST_CAPTURE_NEEDLE" pane-progressive /tmp/progressive.sock
capture_context=$REPLY
capture_source=$reply[1]
capture_label=$reply[2]
typeset -a capture_tiers=( "${(@f)$(<"$capture_log")}" )
_expect_eq 'progressive capture stops at the first command match' \
  80,160 "${(j:,:)capture_tiers}"
_expect_eq 'progressive capture reports the Herdr source' \
  herdr "$capture_source"
_expect_eq 'progressive capture labels an exact anchor match' \
  'matched command' "$capture_label"
if [[ $capture_context == *"$TEST_CAPTURE_NEEDLE"* ]]; then
  _pass 'progressive capture retains the matched command context'
else
  _fail 'progressive capture retains the matched command context'
fi

: > "$capture_log"
TEST_CAPTURE_MATCH_AT=9999
_expect_ok 'progressive capture retains recent pane text without a match' \
  _shellq_progressive_capture \
  "$TEST_CAPTURE_NEEDLE" pane-progressive /tmp/progressive.sock
capture_label=$reply[2]
capture_tiers=( "${(@f)$(<"$capture_log")}" )
_expect_eq 'progressive capture stops at the 640-line ceiling' \
  80,160,320,640 "${(j:,:)capture_tiers}"
_expect_eq 'unmatched pane text is labeled as approximate' \
  'recent pane only' "$capture_label"

herdr() {
  return 1
}
tmux() {
  print -r -- tmux-progressive
}
TMUX=mock
_expect_ok 'progressive capture falls through from Herdr to tmux' \
  _shellq_progressive_capture \
  "$TEST_CAPTURE_NEEDLE" pane-progressive /tmp/progressive.sock
_expect_eq 'progressive fallback reports the tmux source' tmux "$reply[1]"

unset TMUX
_expect_fail 'progressive capture reports unavailable without Herdr or tmux' \
  _shellq_progressive_capture "$TEST_CAPTURE_NEEDLE" '' ''
_expect_eq 'unavailable progressive capture reports no source' none "$reply[1]"

typeset -i saved_search_bytes=$SHELLQ_CAPTURE_SEARCH_MAX_BYTES
typeset -i saved_final_capture_bytes=$SHELLQ_CAPTURE_MAX_BYTES
SHELLQ_CAPTURE_SEARCH_MAX_BYTES=32
SHELLQ_CAPTURE_MAX_BYTES=16
: > "$capture_log"
herdr() {
  print -r -- "$7" >> "$TEST_CAPTURE_LOG"
  print -rn -- "${(l:100::x:)}"
}
_expect_ok 'progressive capture applies its hard search-byte ceiling' \
  _shellq_progressive_capture \
  "$TEST_CAPTURE_NEEDLE" pane-progressive /tmp/progressive.sock
capture_tiers=( "${(@f)$(<"$capture_log")}" )
_expect_eq 'search-byte ceiling stops further pane expansion' \
  80 "${(j:,:)capture_tiers}"
typeset -i progressive_bytes
progressive_bytes=$(print -rn -- "$REPLY" | command wc -c)
if (( progressive_bytes <= 16 )); then
  _pass 'progressive context applies the final 16-byte test cap'
else
  _fail 'progressive context applies the final 16-byte test cap' \
    "$progressive_bytes bytes"
fi
SHELLQ_CAPTURE_SEARCH_MAX_BYTES=$saved_search_bytes
SHELLQ_CAPTURE_MAX_BYTES=$saved_final_capture_bytes

functions[herdr]=$saved_progressive_herdr
functions[tmux]=$saved_progressive_tmux
command rm -f -- "$capture_log"

typeset saved_workbench_runner=${functions[_shellq_run_workbench]}
typeset saved_workbench_capture=${functions[_shellq_progressive_capture]}
typeset -a saved_workbench_provider=("${SHELLQ_PROVIDER[@]}")
typeset -a saved_workbench_command=("${SHELLQ_WORKBENCH_COMMAND[@]}")
typeset -i saved_workbench_response_max=$SHELLQ_RESPONSE_MAX_BYTES
typeset -gi TEST_WORKBENCH_CALLS=0
typeset -gi TEST_WORKBENCH_CAPTURE_CALLS=0
typeset -g TEST_WORKBENCH_MODE=accept
typeset -g TEST_WORKBENCH_SESSION=''
typeset -g TEST_WORKBENCH_SESSION_PATH=''
typeset -g TEST_WORKBENCH_RESULT_PATH=''
typeset -g TEST_WORKBENCH_FOOTER_PATH=''
typeset -g TEST_WORKBENCH_WORKDIR=''
typeset -g TEST_WORKBENCH_SESSION_MODE=''
typeset -g TEST_WORKBENCH_FOOTER_MODE=''
typeset -g TEST_WORKBENCH_DIRECTORY_MODE=''
typeset -g TEST_WORKBENCH_RESPONSE
TEST_WORKBENCH_RESPONSE=$(jq -cn '{
  tldr: "workbench candidate",
  corrected_command: "_would_execute",
  confidence: 1,
  risk: "low"
}')

_shellq_progressive_capture() {
  (( ++TEST_WORKBENCH_CAPTURE_CALLS ))
  REPLY='captured prior output'
  reply=(herdr 'matched command' true)
}

_shellq_run_workbench() {
  (( ++TEST_WORKBENCH_CALLS ))
  TEST_WORKBENCH_SESSION=$(<"$1")
  TEST_WORKBENCH_SESSION_PATH=$1
  TEST_WORKBENCH_RESULT_PATH=$2
  TEST_WORKBENCH_FOOTER_PATH=$2.footer
  TEST_WORKBENCH_WORKDIR=$3
  TEST_WORKBENCH_SESSION_MODE=$(command stat -c '%a' "$1" 2>/dev/null || command stat -f '%Lp' "$1")
  TEST_WORKBENCH_FOOTER_MODE=$(command stat -c '%a' "$2.footer" 2>/dev/null || command stat -f '%Lp' "$2.footer")
  TEST_WORKBENCH_DIRECTORY_MODE=$(command stat -c '%a' "${1:h}" 2>/dev/null || command stat -f '%Lp' "${1:h}")
  case $TEST_WORKBENCH_MODE in
    accept) print -rn -- "$TEST_WORKBENCH_RESPONSE" > "$2" ;;
    malformed) print -rn -- '{}' > "$2" ;;
    oversized) print -rn -- "${(l:100::x:)}" > "$2" ;;
    interrupt) return 130 ;;
    cancel) ;;
  esac
}

SHELLQ_PROVIDER=(/usr/bin/true)
_SHELLQ_LAST_COMMAND='printf prior'
_SHELLQ_LAST_CWD=$PWD
_SHELLQ_LAST_STATUS=0
_SHELLQ_LAST_PIPESTATUS=(0)
_SHELLQ_LAST_PID=$$
_SHELLQ_LAST_HERDR_SOCKET_PATH=/tmp/workbench.sock
_SHELLQ_LAST_HERDR_PANE_ID=pane-workbench
_SHELLQ_LAST_SEQUENCE=101
BUFFER='show recent output'
CURSOR=4
TEST_ZLE_CALLS=()
TEST_WORKBENCH_MODE=accept
_expect_ok 'workbench accepts a parent-valid result' _shellq_workbench
_expect_eq 'workbench inserts but does not execute' _would_execute "$BUFFER"
_expect_eq 'workbench positions the cursor at the end' "${#BUFFER}" "$CURSOR"
_expect_eq 'workbench acceptance never executes the command' \
  0 "$TEST_EXECUTIONS"
if jq -e '
  .initial_intent == "generate"
  and .requests.generate.mode == "generate"
  and .requests.generate.input.command == "show recent output"
  and .requests.ask.mode == "ask"
  and .requests.ask.input.query == ""
  and .requests.correct == null
  and .actionable_failure == false
  and .context.included == false
  and .context.source == "herdr"
  and .context.label == "matched command"
  and .last_command.command == "printf prior"
  and .last_command.cwd == $ENV.PWD
  and .last_command.exit_status == 0
  and .last_command.pipeline_statuses == [0]
  and .provider == ["/usr/bin/true"]
  and .codex_ask_engine == null
  and .model == "gpt-5.6-luna"
  and .reasoning == "low"
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'workbench session exposes exact metadata and opt-in pane context'
else
  _fail 'workbench session exposes exact metadata and opt-in pane context'
fi

TEST_WORKBENCH_MODE=cancel
BUFFER='bundled engine probe'
CURSOR=${#BUFFER}
SHELLQ_PROVIDER=("$_SHELLQ_SRC_DIR/codex-provider.zsh")
SHELLQ_CODEX_ASK_ENGINE=app-server
_expect_ok 'exact bundled provider accepts the App Server engine' \
  _shellq_workbench
_expect_eq 'exact bundled provider snapshots the App Server engine' \
  app-server "$(jq -r '.codex_ask_engine' <<< "$TEST_WORKBENCH_SESSION")"

SHELLQ_PROVIDER=("$_SHELLQ_SRC_DIR/codex-provider.zsh" --extra)
SHELLQ_CODEX_ASK_ENGINE=invalid-custom-value
_expect_ok 'suffixed provider ignores the managed engine enum' \
  _shellq_workbench
if jq -e --arg provider "$_SHELLQ_SRC_DIR/codex-provider.zsh" '
  .provider == [$provider, "--extra"]
  and .codex_ask_engine == null
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'suffixed provider stays exact and unmanaged'
else
  _fail 'suffixed provider stays exact and unmanaged'
fi

SHELLQ_PROVIDER=("$_SHELLQ_SRC_DIR/codex-provider.zsh")
typeset -i calls_before_invalid_engine=$TEST_WORKBENCH_CALLS
_expect_fail 'exact bundled provider rejects an invalid engine enum' \
  _shellq_workbench
_expect_eq 'invalid bundled engine starts no workbench' \
  "$calls_before_invalid_engine" "$TEST_WORKBENCH_CALLS"
SHELLQ_CODEX_ASK_ENGINE=app-server
SHELLQ_APP_SERVER_REUSE=invalid
typeset -i calls_before_invalid_reuse=$TEST_WORKBENCH_CALLS
_expect_fail 'exact bundled provider rejects an invalid reuse setting' \
  _shellq_workbench
_expect_eq 'invalid reuse setting starts no workbench' \
  "$calls_before_invalid_reuse" "$TEST_WORKBENCH_CALLS"
SHELLQ_APP_SERVER_REUSE=0
_expect_ok 'exact bundled provider accepts the rollback setting' \
  _shellq_workbench
SHELLQ_APP_SERVER_REUSE=1
SHELLQ_PROVIDER=(/usr/bin/true)

_expect_eq 'workbench receives shell cwd outside request JSON' \
  "$PWD" "$TEST_WORKBENCH_WORKDIR"
_expect_eq 'workbench session file is private' 600 \
  "$TEST_WORKBENCH_SESSION_MODE"
_expect_eq 'workbench derives a private footer receipt beside its result' \
  "$TEST_WORKBENCH_RESULT_PATH.footer:600" \
  "$TEST_WORKBENCH_FOOTER_PATH:$TEST_WORKBENCH_FOOTER_MODE"
_expect_eq 'workbench state directory is private' 700 \
  "$TEST_WORKBENCH_DIRECTORY_MODE"
if [[ ! -e $TEST_WORKBENCH_SESSION_PATH &&
      ! -e $TEST_WORKBENCH_RESULT_PATH &&
      ! -e $TEST_WORKBENCH_FOOTER_PATH ]]; then
  _pass 'workbench private files are removed'
else
  _fail 'workbench private files are removed'
fi
typeset zle_sequence="${(j:|:)TEST_ZLE_CALLS}"
if [[ $zle_sequence == *'-I'* &&
      $zle_sequence == *'reset-prompt'* &&
      $zle_sequence == *'-R'* ]]; then
  _pass 'workbench flushes and restores the ZLE prompt'
else
  _fail 'workbench flushes and restores the ZLE prompt' "$zle_sequence"
fi

BUFFER='keep this buffer'
CURSOR=5
TEST_WORKBENCH_MODE=cancel
_expect_ok 'workbench cancellation is local' _shellq_workbench
_expect_eq 'cancelled workbench preserves the buffer' \
  'keep this buffer' "$BUFFER"
_expect_eq 'cancelled workbench preserves the cursor' 5 "$CURSOR"

BUFFER='keep malformed'
CURSOR=3
TEST_WORKBENCH_MODE=malformed
_expect_fail 'malformed workbench result is rejected' _shellq_workbench
_expect_eq 'malformed workbench result preserves the buffer' \
  'keep malformed' "$BUFFER"
_expect_eq 'malformed workbench result preserves the cursor' 3 "$CURSOR"

BUFFER='keep interrupted'
CURSOR=7
TEST_WORKBENCH_MODE=interrupt
_expect_fail 'interrupted workbench is rejected' _shellq_workbench
_expect_eq 'interrupted workbench preserves the buffer' \
  'keep interrupted' "$BUFFER"
_expect_eq 'interrupted workbench preserves the cursor' 7 "$CURSOR"

SHELLQ_RESPONSE_MAX_BYTES=32
BUFFER='keep oversized'
CURSOR=8
TEST_WORKBENCH_MODE=oversized
_expect_fail 'oversized workbench result is rejected' _shellq_workbench
_expect_eq 'oversized workbench result preserves the buffer' \
  'keep oversized' "$BUFFER"
SHELLQ_RESPONSE_MAX_BYTES=$saved_workbench_response_max

_SHELLQ_LAST_COMMAND='missing-workbench-command'
_SHELLQ_LAST_STATUS=127
_SHELLQ_LAST_PIPESTATUS=(127)
BUFFER=''
CURSOR=0
TEST_WORKBENCH_MODE=cancel
_expect_ok 'workbench opens explicitly for an actionable failure' \
  _shellq_workbench
if jq -e '
  .initial_intent == "correct"
  and .requests.correct.mode == "correct"
  and .requests.correct.input.command == "missing-workbench-command"
  and .requests.ask.mode == "ask"
  and .actionable_failure == true
  and .context.included == true
  and .last_command.exit_status == 127
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'failure workbench includes bounded context by explicit invocation'
else
  _fail 'failure workbench includes bounded context by explicit invocation'
fi

BUFFER='describe a different command'
CURSOR=9
TEST_WORKBENCH_MODE=cancel
_expect_ok 'nonempty buffer still opens Command when a failure is available' \
  _shellq_workbench
if jq -e '
  .initial_intent == "generate"
  and .requests.generate.input.command == "describe a different command"
  and .requests.correct.input.command == "missing-workbench-command"
  and .actionable_failure == true
  and .context.included == true
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'Command-start session retains Fix and its captured failure context'
else
  _fail 'Command-start session retains Fix and its captured failure context'
fi
_expect_eq 'Command-start cancellation preserves its buffer' \
  'describe a different command' "$BUFFER"
_expect_eq 'Command-start cancellation preserves its cursor' 9 "$CURSOR"

_SHELLQ_LAST_STATUS=0
BUFFER=''
CURSOR=0
TEST_WORKBENCH_CALLS=0
TEST_WORKBENCH_CAPTURE_CALLS=0
TEST_WORKBENCH_MODE=cancel
_expect_ok 'empty prompt opens the universal workbench in Ask mode' \
  _shellq_workbench
_expect_eq 'Ask open preserves the empty buffer' '' "$BUFFER"
_expect_eq 'Ask open preserves the cursor' 0 "$CURSOR"
_expect_eq 'Ask open reuses local context discovery' 1 \
  "$TEST_WORKBENCH_CAPTURE_CALLS"
_expect_eq 'Ask open starts the workbench exactly once' 1 \
  "$TEST_WORKBENCH_CALLS"
if jq -e '
  .initial_intent == "ask"
  and .requests.ask.mode == "ask"
  and .requests.ask.input.query == ""
  and .requests.generate.input.command == ""
  and .requests.correct == null
  and .actionable_failure == false
  and .context.included == false
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'empty prompt creates an inert Ask session'
else
  _fail 'empty prompt creates an inert Ask session'
fi
_expect_eq 'Ask session receives the shell cwd separately' \
  "$PWD" "$TEST_WORKBENCH_WORKDIR"

TEST_WORKBENCH_RESPONSE='{"answer":"this must never enter BUFFER"}'
TEST_WORKBENCH_MODE=accept
BUFFER=''
CURSOR=0
_expect_fail 'fabricated Ask result is rejected by the parent command gate' \
  _shellq_workbench
_expect_eq 'fabricated Ask result cannot change BUFFER' '' "$BUFFER"
_expect_eq 'fabricated Ask result cannot change CURSOR' 0 "$CURSOR"
TEST_WORKBENCH_RESPONSE=$(jq -cn '{
  tldr: "workbench candidate",
  corrected_command: "_would_execute",
  confidence: 1,
  risk: "low"
}')

_shellq_footer_cleanup_probe() {
  emulate -L zsh
  zmodload zsh/zpty || return 1

  local receipt=$1 child_status=$2
  local name=shellq_footer_probe_$$
  local output='' chunk=''
  local -i attempt=0
  local child_script='source "$1"
zle() { :; }
_shellq_progressive_capture() { return 1; }
_shellq_test_child() { :; }
_shellq_run_workbench() {
  (( ++SHELLQ_TEST_WORKBENCH_CALLS ))
  [[ $SHELLQ_TEST_RECEIPT == __missing__ ]] ||
    print -rn -- "$SHELLQ_TEST_RECEIPT" > "$2.footer"
  LINES=$SHELLQ_TEST_LINES_AFTER
  return $SHELLQ_TEST_STATUS
}
SHELLQ_PROVIDER=(/usr/bin/true)
SHELLQ_WORKBENCH_COMMAND=(_shellq_test_child)
SHELLQ_TEST_RECEIPT=$2
SHELLQ_TEST_STATUS=$3
SHELLQ_TEST_LINES_AFTER=$4
typeset -gi SHELLQ_TEST_WORKBENCH_CALLS=0
_SHELLQ_LAST_SEQUENCE=0
BUFFER=typed
CURSOR=5
LINES=40
_shellq_workbench
print -r -- "__STATUS__=$? __CALLS__=$SHELLQ_TEST_WORKBENCH_CALLS"'

  zpty -b "$name" zsh -dfc ${(q)child_script} -- \
    ${(q)TEST_PLUGIN} ${(q)receipt} "$child_status" "${3:-40}" || return 1
  {
    for attempt in {1..100}; do
      chunk=''
      zpty -r -t "$name" chunk && output+=$chunk
      [[ $output == *$'\e[6n'* ]] && break
      command sleep 0.01
    done
    [[ $output == *$'\e[6n'* ]] || return 1
    if [[ $receipt == __delayed_cpr__ ]]; then
      command sleep 0.25
      zpty -w "$name" $'\e[39;1R' || return 1
    elif [[ $receipt != __no_cpr__ ]]; then
      zpty -w "$name" $'\e[39;1R' || return 1
    fi
    for attempt in {1..100}; do
      chunk=''
      zpty -r -t "$name" chunk && output+=$chunk
      [[ $output == *__STATUS__=* ]] && break
      zpty -t "$name" || break
      command sleep 0.01
    done
    [[ $output == *__STATUS__=* ]] || return 1
    REPLY=$output
  } always {
    zpty -d "$name" >/dev/null 2>&1 || true
  }
}

if _shellq_footer_cleanup_probe peak_height=1 0 &&
   [[ $REPLY == *$'\e[39;1H\e[J'* ]]; then
  _pass 'footer cleanup accepts the lower height bound'
else
  _fail 'footer cleanup accepts the lower height bound'
fi
if _shellq_footer_cleanup_probe peak_height=12 0 &&
   [[ $REPLY == *$'\e[28;1H\e[J'* ]]; then
  _pass 'footer cleanup uses the reported dynamic peak through the upper bound'
else
  _fail 'footer cleanup uses the reported dynamic peak through the upper bound'
fi
if _shellq_footer_cleanup_probe peak_height=8 17 &&
   [[ $REPLY == *$'\e[32;1H\e[J'* && $REPLY == *__STATUS__=1* ]]; then
  _pass 'nonzero workbench exits still reclaim the reported footer peak'
else
  _fail 'nonzero workbench exits still reclaim the reported footer peak'
fi
if _shellq_footer_cleanup_probe peak_height=12 0 8 &&
   [[ $REPLY != *$'\e[J'* ]]; then
  _pass 'footer cleanup never clears the viewport after a shorter resize'
else
  _fail 'footer cleanup never clears the viewport after a shorter resize'
fi
if _shellq_footer_cleanup_probe __no_cpr__ 0 40 &&
   [[ $REPLY == *__STATUS__=1*__CALLS__=0* ]]; then
  _pass 'missing cursor anchor fails before the workbench renderer starts'
else
  _fail 'missing cursor anchor fails before the workbench renderer starts'
fi
typeset delayed_cpr_without_query
if _shellq_footer_cleanup_probe __delayed_cpr__ 0 40; then
  delayed_cpr_without_query=${REPLY//$'\e[6n'/}
  if (( ${#REPLY} - ${#delayed_cpr_without_query} == 4 )) &&
     [[ $REPLY == *__CALLS__=1* && $REPLY != *$'\e[39;1R'* ]]; then
    _pass 'one delayed cursor reply is consumed without a queued second reply'
  else
    _fail 'one delayed cursor reply is consumed without a queued second reply'
  fi
else
  _fail 'one delayed cursor reply is consumed without a queued second reply'
fi
typeset footer_receipt
for footer_receipt in peak_height=0 peak_height=17 peak_height=8x __missing__; do
  if _shellq_footer_cleanup_probe "$footer_receipt" 0 &&
     [[ $REPLY != *$'\e[J'* ]]; then
    _pass "invalid or missing footer receipt does not guess: $footer_receipt"
  else
    _fail "invalid or missing footer receipt does not guess: $footer_receipt"
  fi
done

BUFFER='typed request'
CURSOR=${#BUFFER}
typeset saved_no_provider_path=$PATH no_provider_root no_provider_jq no_provider_mktemp no_provider_chmod no_provider_rm no_provider_stat
no_provider_root=$(mktemp -d "${TMPDIR:-/tmp}/shellq-no-provider.XXXXXX")
no_provider_jq=$commands[jq]
no_provider_mktemp=$commands[mktemp]
no_provider_chmod=$commands[chmod]
no_provider_rm=$commands[rm]
no_provider_stat=$commands[stat]
command ln -s -- "$no_provider_jq" "$no_provider_root/jq"
command ln -s -- "$no_provider_mktemp" "$no_provider_root/mktemp"
command ln -s -- "$no_provider_chmod" "$no_provider_root/chmod"
command ln -s -- "$no_provider_rm" "$no_provider_root/rm"
command ln -s -- "$no_provider_stat" "$no_provider_root/stat"
PATH=$no_provider_root
rehash
SHELLQ_PROVIDER=("$_SHELLQ_DEFAULT_PROVIDER")
SHELLQ_WORKBENCH_COMMAND=(_shellq_run_workbench)
TEST_WORKBENCH_CALLS=0
TEST_WORKBENCH_CAPTURE_CALLS=0
TEST_ZLE_CALLS=()
BUFFER='no provider request'
CURSOR=${#BUFFER}
TEST_WORKBENCH_MODE=cancel
_expect_ok 'managed default mounts when no registered CLI is installed' _shellq_workbench
_expect_eq 'managed no-provider state reaches the workbench' 1 "$TEST_WORKBENCH_CALLS"
_expect_eq 'managed no-provider state still captures context' 1 "$TEST_WORKBENCH_CAPTURE_CALLS"
if jq -e --arg provider "$_SHELLQ_DEFAULT_PROVIDER" '
  .provider_source == "default" and .provider == [$provider]
' <<< "$TEST_WORKBENCH_SESSION" >/dev/null; then
  _pass 'managed no-provider session keeps its bundled adapter authority'
else
  _fail 'managed no-provider session keeps its bundled adapter authority' \
    "$TEST_WORKBENCH_SESSION"
fi
SHELLQ_PROVIDER=()
TEST_WORKBENCH_CALLS=0
TEST_WORKBENCH_CAPTURE_CALLS=0
BUFFER='empty configured provider'
CURSOR=7
_expect_fail 'empty configured provider is rejected before workbench mount' _shellq_workbench
_expect_eq 'empty configured provider preserves the shell buffer' \
  'empty configured provider' "$BUFFER"
_expect_eq 'empty configured provider preserves the shell cursor' 7 "$CURSOR"
_expect_eq 'empty configured provider performs no capture' 0 \
  "$TEST_WORKBENCH_CAPTURE_CALLS"
SHELLQ_PROVIDER=("$_SHELLQ_DEFAULT_PROVIDER")
PATH=$saved_no_provider_path
rehash
command rm -rf -- "$no_provider_root"
BUFFER='typed request'
CURSOR=${#BUFFER}

TEST_WORKBENCH_CAPTURE_CALLS=0
SHELLQ_WORKBENCH_COMMAND=(/definitely/missing/shellq-workbench)
_expect_fail 'unavailable workbench fails locally' _shellq_workbench
_expect_eq 'unavailable workbench performs no capture' 0 \
  "$TEST_WORKBENCH_CAPTURE_CALLS"
_expect_eq 'unavailable workbench preserves the buffer' \
  'typed request' "$BUFFER"

SHELLQ_PROVIDER=("${saved_workbench_provider[@]}")
SHELLQ_WORKBENCH_COMMAND=("${saved_workbench_command[@]}")
SHELLQ_RESPONSE_MAX_BYTES=$saved_workbench_response_max
functions[_shellq_run_workbench]=$saved_workbench_runner
functions[_shellq_progressive_capture]=$saved_workbench_capture

typeset workbench_bindings
typeset -i workbench_binding_status=1
workbench_bindings=$(zsh -dfi -c '
  source "$1"
  _shellq_test_user_widget() { :; }
  zle -N _shellq_test_user_widget

  widget_for() {
    local binding
    binding=$(bindkey -M "$1" "$2") || return 1
    print -r -- "${binding##* }"
  }

  for map in emacs viins; do
    bindkey -M "$map" "^I" _shellq_test_user_widget
  done
  _shellq_bindkeys

  for map in emacs viins; do
    [[ $(widget_for "$map" "^O") == _shellq_workbench ]] || exit 81
    [[ $(widget_for "$map" "^I") == _shellq_accept_or_complete ]] || exit 82
    [[ ${_SHELLQ_TAB_PRIOR[$map]} == _shellq_test_user_widget ]] || exit 83
    [[ $(bindkey -M "$map") != *_shellq_inline_generate* ]] || exit 84
    [[ $(widget_for "$map" "^[o") == undefined-key ]] || exit 85
    [[ $(widget_for "$map" "^[e") == undefined-key ]] || exit 86
  done

  # Reloading must not record our own widget as the prior Tab binding; that
  # would make the fallthrough recurse into itself.
  _shellq_bindkeys

  for map in emacs viins; do
    [[ ${_SHELLQ_TAB_PRIOR[$map]} == _shellq_test_user_widget ]] || exit 87
    [[ $(widget_for "$map" "^I") == _shellq_accept_or_complete ]] || exit 88
  done

  print -r -- bindings-ok
' _ "$TEST_PLUGIN")
workbench_binding_status=$?
if (( workbench_binding_status == 0 )) &&
   [[ $workbench_bindings == bindings-ok ]]; then
  _pass 'Ctrl-O opens workbench; no Alt binding is installed; a reload preserves the user prior Tab widget without self-recording'
else
  _fail 'Ctrl-O opens workbench; no Alt binding is installed; a reload preserves the user prior Tab widget without self-recording' \
    "status $workbench_binding_status, ${(qqq)workbench_bindings}"
fi

if (( TEST_FAILURES )); then
  print -ru2 -- "FAIL $TEST_FAILURES/$TEST_CHECKS checks"
  exit 1
fi

print -r -- "PASS $TEST_CHECKS checks"
