#!/usr/bin/env zsh

emulate -LR zsh
setopt no_aliases pipe_fail

typeset -gi checks=0 failures=0
typeset -gr plugin=${0:A:h:h}/shellq.plugin.zsh

pass() { (( ++checks )); print -r -- "ok $checks - $1" }
fail() { (( ++checks, ++failures )); print -ru2 -- "not ok $checks - $1${2:+: $2}" }
expect_eq() {
  local label=$1 expected=$2 actual=$3
  [[ $actual == "$expected" ]] && pass "$label" || fail "$label" \
    "expected ${(qqq)expected}, got ${(qqq)actual}"
}

zle() { :; }


source "$plugin" || exit 1
source "$plugin" || exit 1

typeset -gr test_root=$(mktemp -d /tmp/shellq-sq10-shell.XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT

typeset -a test_commands=(
  'echo ordinary'
  $'printf embedded\nprintf line'
  $'printf trailing\n\n'
  "echo . inside"
  "echo trailing."
)
typeset command response
for command in "${test_commands[@]}"; do
  response=$(jq -cn --arg command "$command" \
    '{tldr:"probe", corrected_command:$command, confidence:1, risk:"low"}')
  if _shellq_extract_corrected_command "$response"; then
    [[ $REPLY == "$command" ]] && pass "extracts exact command: ${(qqq)command}" ||
      fail "extracts exact command: ${(qqq)command}" "got ${(qqq)REPLY}"
  else
    fail "extracts exact command: ${(qqq)command}" 'unexpected jq failure'
  fi
done

response='{"corrected_command":null}'
if _shellq_extract_corrected_command "$response"; then
  expect_eq 'null extracts as empty' '' "$REPLY"
else
  fail 'null extracts as empty' 'unexpected jq failure'
fi
REPLY=stale
if _shellq_extract_corrected_command '{'; then
  fail 'jq failure is reported' 'unexpected success'
else
  pass 'jq failure is reported'
  expect_eq 'jq failure clears REPLY' '' "$REPLY"
fi

typeset pending_command="touch ${(q)test_root}/executed-pending"$'\n\n' 
response=$(jq -cn --arg command "$pending_command" \
  '{tldr:"pending", corrected_command:$command, confidence:1, risk:"low"}')
_SHELLQ_LAST_SEQUENCE=1
_SHELLQ_ANALYSIS_STARTED_AT=$EPOCHREALTIME
_SHELLQ_ANALYSIS_SEQUENCE=1
_SHELLQ_ANALYSIS_SHELL_PID=$$
_SHELLQ_ANALYSIS_HERDR_SOCKET_PATH=${HERDR_SOCKET_PATH:-}
_SHELLQ_ANALYSIS_HERDR_PANE_ID=${HERDR_PANE_ID:-}
BUFFER=''
CURSOR=0
_shellq_clear_pending
if _shellq_finish_analysis 0 "$response"; then
  expect_eq 'analysis stores exact pending command' "$pending_command" \
    "$_SHELLQ_PENDING_CORRECTION"
  _shellq_accept_or_complete
  expect_eq 'pending acceptance preserves trailing newlines' "$pending_command" "$BUFFER"
  expect_eq 'pending acceptance places cursor at end' "${#BUFFER}" "$CURSOR"
else
  fail 'analysis accepts valid response'
fi

typeset -g SQ10_RESPONSE
_sq10_provider() {
  command cat >/dev/null
  print -rn -- "$SQ10_RESPONSE"
}

typeset inline_command="touch ${(q)test_root}/executed-inline"$'\n\n' 
SQ10_RESPONSE=$(jq -cn --arg command "$inline_command" \
  '{tldr:"inline", corrected_command:$command, confidence:1, risk:"low"}')
SHELLQ_PROVIDER=(_sq10_provider)
BUFFER='generate this'
CURSOR=${#BUFFER}
if _shellq_inline_generate; then
  expect_eq 'inline insertion preserves trailing newlines' "$inline_command" "$BUFFER"
  expect_eq 'inline insertion places cursor at end' "${#BUFFER}" "$CURSOR"
else
  fail 'inline caller accepts valid response'
fi

SHELLQ_PROVIDER=(/usr/bin/true)
SHELLQ_WORKBENCH_COMMAND=(/usr/bin/true)
_shellq_progressive_capture() { return 1; }
_shellq_run_workbench() { print -rn -- "$SQ10_RESPONSE" > "$2"; }
typeset workbench_command="touch ${(q)test_root}/executed-workbench"$'\n\n' 
SQ10_RESPONSE=$(jq -cn --arg command "$workbench_command" \
  '{tldr:"workbench", corrected_command:$command, confidence:1, risk:"low"}')
_SHELLQ_LAST_COMMAND='prior'
_SHELLQ_LAST_CWD=$PWD
_SHELLQ_LAST_STATUS=0
_SHELLQ_LAST_PIPESTATUS=(0)
_SHELLQ_LAST_PID=$$
_SHELLQ_LAST_HERDR_SOCKET_PATH=''
_SHELLQ_LAST_HERDR_PANE_ID=''
_SHELLQ_LAST_SEQUENCE=0
BUFFER='workbench request'
CURSOR=4
if _shellq_workbench; then
  expect_eq 'workbench acceptance preserves trailing newlines' "$workbench_command" "$BUFFER"
  expect_eq 'workbench acceptance places cursor at end' "${#BUFFER}" "$CURSOR"
else
  fail 'workbench caller accepts valid response'
fi

_shellq_run_workbench() { return 130; }
BUFFER='cancel this'
CURSOR=3
if _shellq_workbench; then
  fail 'workbench cancellation reports failure' 'unexpected success'
else
  pass 'workbench cancellation reports failure'
fi
expect_eq 'workbench cancellation restores buffer' 'cancel this' "$BUFFER"
expect_eq 'workbench cancellation restores cursor' 3 "$CURSOR"
for marker in pending inline workbench; do
  [[ ! -e $test_root/executed-$marker ]] && pass "$marker command was not executed" || fail "$marker command was executed"
done


# Exercise the real ZLE widget boundary; only the foreground UI result is stubbed.
zmodload zsh/zpty || exit 1
print -rn -- "$SQ10_RESPONSE" > "$test_root/response.json"
cat > "$test_root/fixture.zsh" <<'ZLE'
unsetopt beep
stty rows 24 columns 100
PROMPT='SQ10> '
SHELLQ_PROVIDER=(/usr/bin/true)
SHELLQ_WORKBENCH_COMMAND=(/usr/bin/true)
source "$SQ10_TEST_PLUGIN"
_shellq_progressive_capture() { return 1; }
_shellq_run_workbench() {
  [[ $SQ10_CANCEL == 1 ]] && return 130
  command cat "$SQ10_TEST_ROOT/response.json" > "$2"
}
_sq10_accept_widget() {
  BUFFER='original request'; CURSOR=3
  SQ10_CANCEL=0
  _shellq_workbench
  jq -cn --arg buffer "$BUFFER" --argjson cursor "$CURSOR" \
    '{buffer:$buffer,cursor:$cursor}' > "$SQ10_TEST_ROOT/accept.json"
}
_sq10_cancel_widget() {
  BUFFER='original request'; CURSOR=3
  SQ10_CANCEL=1
  _shellq_workbench
  jq -cn --arg buffer "$BUFFER" --argjson cursor "$CURSOR" \
    '{buffer:$buffer,cursor:$cursor}' > "$SQ10_TEST_ROOT/cancel.json"
}
zle -N _sq10_accept_widget
zle -N _sq10_cancel_widget
bindkey '^O' _sq10_accept_widget
bindkey '^P' _sq10_cancel_widget
print ready > "$SQ10_TEST_ROOT/ready"
ZLE

typeset terminal_output
if zpty -b sq10 env SQ10_TEST_ROOT="$test_root" SQ10_TEST_PLUGIN="$plugin" zsh -dfi; then
  {
    zpty -w sq10 "source ${(q)test_root}/fixture.zsh"
    # macOS ptys have small buffers: drain output so the child is not blocked
    # writing its prompt and echo while the fixture loads.
    repeat 500; do
      while zpty -r -t sq10 terminal_output; do :; done
      [[ -s $test_root/ready ]] && break
      sleep 0.02
    done
    [[ -s $test_root/ready ]] || fail 'ZLE fixture starts'
    zpty -w -n sq10 $'\x0f'
    repeat 100; do
      while zpty -r -t sq10 terminal_output; do
        [[ $terminal_output == *$'\e[6n'* ]] && zpty -w -n sq10 $'\e[3;1R'
      done
      [[ -s $test_root/accept.json ]] && break
      sleep 0.02
    done
    if [[ -s $test_root/accept.json ]] && jq -e --arg command "$workbench_command" \
      '.buffer == $command and .cursor == ($command | length)' "$test_root/accept.json" >/dev/null; then
      pass 'real ZLE acceptance preserves BUFFER and CURSOR exactly'
    else
      fail 'real ZLE acceptance preserves BUFFER and CURSOR exactly' "$(cat "$test_root/accept.json" 2>/dev/null)"
    fi
    zpty -w -n sq10 $'\x10'
    repeat 100; do
      while zpty -r -t sq10 terminal_output; do
        [[ $terminal_output == *$'\e[6n'* ]] && zpty -w -n sq10 $'\e[3;1R'
      done
      [[ -s $test_root/cancel.json ]] && break
      sleep 0.02
    done
    if [[ -s $test_root/cancel.json ]] && jq -e \
      '.buffer == "original request" and .cursor == 3' "$test_root/cancel.json" >/dev/null; then
      pass 'real ZLE cancellation restores BUFFER and CURSOR'
    else
      fail 'real ZLE cancellation restores BUFFER and CURSOR'
    fi
    [[ ! -e $test_root/executed-workbench ]] && pass 'real ZLE never executes accepted command' || fail 'real ZLE executes accepted command'
  } always {
    zpty -d sq10
  }
else
  fail 'could not create disposable ZLE terminal'
fi

if (( failures )); then
  print -ru2 -- "FAIL $failures/$checks checks"
  exit 1
fi
print -r -- "PASS $checks checks"
