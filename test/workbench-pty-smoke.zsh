#!/usr/bin/env zsh

emulate -LR zsh
setopt no_unset pipe_fail

typeset -gr SCRIPT_PATH=${0:A}

provider() {
  local mode=$1
  local request
  local -i child_pid=0

  if [[ $mode == slow ]]; then
    (( ${+SHELLQ_STREAM_PREVIEW} == 0 )) || return 72
    print -r -- $$ > "$SHELLQ_PTY_PROVIDER_PID"
    trap '(( child_pid > 0 )) && kill -TERM "$child_pid" 2>/dev/null; exit 143' \
      HUP INT TERM
    command sleep 30 &
    child_pid=$!
    wait "$child_pid"
    return $?
  fi

  if [[ $mode == failure ]]; then
    (( ${+SHELLQ_STREAM_PREVIEW} == 0 )) || return 72
    print -ru2 -- $'\u009b2Junsafe provider error'
    return 1
  fi

  request=$(command cat)
  print -r -- "$request" >> "$SHELLQ_PTY_PROVIDER_LOG"
  if [[ $mode == no-safe ]]; then
    jq -cn '{
      tldr: "the intended path cannot be inferred safely",
      corrected_command: null,
      confidence: 0.2,
      risk: "unknown intent"
    }'
    return
  fi
  if jq -e '.mode == "ask"' <<< "$request" >/dev/null; then
    [[ ${SHELLQ_STREAM_PREVIEW:-0} == 1 ]] || return 70
    jq -cn '{ t: "delta", text: "PTY_STREAM_PREVIEW_CANARY_604" }'
    command sleep 0.5
    if [[ $mode == long-answer ]]; then
      jq -cn --arg answer $'line 01 repository summary\nline 02 repository summary\nline 03 repository summary\nline 04 repository summary\nline 05 repository summary\nline 06 repository summary\nline 07 repository summary\nline 08 repository summary\nline 09 repository summary\nline 10 repository summary\nline 11 repository summary\nline 12 repository summary\nASK_SCROLL_BOTTOM' \
        '{ answer: $answer }'
    else
      jq -cn '{ answer: "Ask answer" }'
    fi
    return
  fi
  (( ${+SHELLQ_STREAM_PREVIEW} == 0 )) || return 71
  local -i call_count
  call_count=$(command wc -l < "$SHELLQ_PTY_PROVIDER_LOG")
  local command="echo suggestion-$call_count"
  local tldr="PTY suggestion"
  if [[ -n ${SHELLQ_PTY_AUTO_EXEC_FILE:-} ]]; then
    command="touch ${SHELLQ_PTY_AUTO_EXEC_FILE}-$call_count"
  fi
  if [[ ${SHELLQ_PTY_CASE:-} == context || ${SHELLQ_PTY_CASE:-} == wheel ]]; then
    tldr="A deliberately long candidate description wraps above the choices without stealing their navigation keys. PageDown scrolls this explanation while arrows continue to select commands. SCROLL_DESCRIPTION_BOTTOM"
  fi
  jq -cn --arg command "$command" --arg tldr "$tldr" '{
    tldr: $tldr,
    corrected_command: $command,
    confidence: 1,
    risk: "low"
  }'
}

child() {
  local before after input
  local -i workbench_status resize_pid=0

  [[ -z ${SHELLQ_PTY_PATH:-} ]] || PATH=$SHELLQ_PTY_PATH
  stty rows 24 cols "${SHELLQ_PTY_START_COLS:-80}" || return 1
  before=$(stty -g) || return 1
  print -r -- "SCROLLBACK_SENTINEL:$SHELLQ_PTY_CASE"

  if [[ -n ${SHELLQ_PTY_RESIZE_COLS:-} ]]; then
    (
      command sleep 0.4
      stty cols "$SHELLQ_PTY_RESIZE_COLS" < /dev/tty
    ) &
    resize_pid=$!
  fi

  "${SHELLQ_PTY_BUN:-bun}" "$SHELLQ_PTY_WORKBENCH" \
    "$SHELLQ_PTY_SESSION" "$SHELLQ_PTY_RESULT" "$SHELLQ_PTY_WORKDIR"
  workbench_status=$?
  (( resize_pid == 0 )) || wait "$resize_pid"

  if [[ -r ${SHELLQ_PTY_RESULT}.footer ]]; then
    print -r -- "FOOTER_RECEIPT:$(<${SHELLQ_PTY_RESULT}.footer)"
  else
    print -r -- FOOTER_RECEIPT:missing
  fi
  after=$(stty -g) || return 1
  print -r -- "WORKBENCH_STATUS:$workbench_status"
  if [[ $before == $after ]]; then
    print -r -- TTY_RESTORED
  else
    print -r -- TTY_NOT_RESTORED
  fi
  IFS= read -r input
  print -r -- "COOKED_INPUT:$input"
}

case ${1:-} in
  provider)
    provider "${2:-fast}"
    exit $?
    ;;
  child)
    child
    exit $?
    ;;
esac

typeset -gr WORKBENCH=${SCRIPT_PATH:h:h}/src/workbench.ts
typeset -gr BUN_BIN=$(command -v bun)
typeset -gr PLUGIN=${SCRIPT_PATH:h:h}/shellq.plugin.zsh
typeset -gr ZSH_BIN=$(command -v zsh)
typeset -gr TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shellq-pty.XXXXXX")
# BSD script (macOS) takes `-qF file cmd...`; util-linux takes `-qfe -c cmd file`.
typeset -gr PTY_SCRIPT=$TEST_DIR/pty-script
command cat > $PTY_SCRIPT <<'PTYSCRIPT'
#!/usr/bin/env -S zsh -f
transcript=$1; shift
[[ $OSTYPE == darwin* ]] && exec /usr/bin/script -qF "$transcript" "$@"
script -qfe -c "${(j: :)${(q)@}}" "$transcript"
st=$?
# util-linux records the command line in a header/footer the BSD transcript lacks.
sed -i -e '/^Script started on .*\[COMMAND=/d' -e '/^Script done on .*\[COMMAND_EXIT_CODE=/d' "$transcript"
exit $st
PTYSCRIPT
chmod 700 $PTY_SCRIPT
typeset -g PTY_TMUX_SOCKET=''
umask 077

cleanup() {
  if [[ -n ${SHELLQ_PTY_KEEP:-} ]]; then
    print -ru2 -- "kept: $TEST_DIR"
    return
  fi
  [[ -z $PTY_TMUX_SOCKET ]] ||
    TMUX='' command tmux -S "$PTY_TMUX_SOCKET" kill-server 2>/dev/null
  command rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT

fail() {
  print -ru2 -- "not ok - $1"
  exit 1
}

contains() {
  LC_ALL=C command grep -aFq -- "$2" "$1"
}

assert_restored() {
  local transcript=$1
  local input=$2
  contains "$transcript" TTY_RESTORED ||
    fail "${transcript:t}: terminal mode was not restored"
  ! contains "$transcript" TTY_NOT_RESTORED ||
    fail "${transcript:t}: terminal mode changed"
  contains "$transcript" WORKBENCH_STATUS:0 ||
    fail "${transcript:t}: workbench did not exit cleanly"
  contains "$transcript" COOKED_INPUT: ||
    fail "${transcript:t}: cooked input marker is missing"
  contains "$transcript" "$input" ||
    fail "${transcript:t}: input was not readable after workbench exit"
}

assert_main_screen() {
  local transcript=$1
  local sequence
  for sequence in $'\e[?47h' $'\e[?1047h' $'\e[?1049h'; do
    ! contains "$transcript" "$sequence" ||
      fail "${transcript:t}: alternate-screen entry was emitted"
  done
}

# Transferred from the deleted disposable frame proof: the whole point of the
# native chassis is that one component owns every edge, so assert it per row on
# a real captured screen rather than trusting the assembled strings.
assert_frame_edges() {
  local screen=$1
  local -i width=$2 rows=$3
  local -a lines
  local line
  local -i total index row_index

  lines=("${(@f)$(<$screen)}")
  total=${#lines}
  (( total >= rows )) || fail "${screen:t}: captured only $total rows"

  for (( index = 1; index <= rows; index++ )); do
    row_index=$(( total - rows + index ))
    line=${lines[row_index]}
    (( ${#line} == width )) ||
      fail "${screen:t}: frame row $index is ${#line} cells, expected $width"
    if (( index == 1 )); then
      [[ ${line[1]} == $'\u256d' && ${line[-1]} == $'\u256e' ]] ||
        fail "${screen:t}: top row did not own both corners"
    elif (( index == rows )); then
      [[ ${line[1]} == $'\u2570' && ${line[-1]} == $'\u256f' ]] ||
        fail "${screen:t}: bottom row did not reach the terminal edge"
    else
      [[ ${line[1]} == $'\u2502' && ${line[-1]} == $'\u2502' ]] ||
        fail "${screen:t}: interior row $index lost a side border"
    fi
  done
}

# Content-driven peaks depend on wrapping, so a case may name every valid step.
assert_peak_height() {
  local transcript=$1 expected
  for expected in "${@:2}"; do
    contains "$transcript" "FOOTER_RECEIPT:peak_height=$expected" && return 0
  done
  expected=${(j:/:)@[2,-1]}
  fail "${transcript:t}: expected finalized peak height $expected, got $(command grep -ao 'FOOTER_RECEIPT:peak_height=[0-9]*' "$transcript")"
}

make_session() {
  local session_path=$1
  local provider_mode=$2
  local initial_intent=${3:-generate}
  local included=${4:-false}
  local actionable=${5:-false}

  jq -cn \
    --arg cwd "$TEST_DIR" \
    --arg initial_intent "$initial_intent" \
    --arg provider_mode "$provider_mode" \
    --arg script "$SCRIPT_PATH" \
    --arg zsh "$ZSH_BIN" \
    --argjson included "$included" \
    --argjson actionable "$actionable" '
      {
        initial_intent: $initial_intent,
        requests: {
          ask: {
            mode: "ask",
            instructions: "Return Ask JSON.",
            input: {
              query: "",
              environment: {
                cwd: $cwd,
                shell: "zsh",
                platform: "darwin"
              },
              captured_output: ""
            }
          },
          generate: {
            mode: "generate",
            instructions: "Return JSON.",
            input: {
              command: "show current directory",
              captured_output: "",
              captured_output_correlated_to_command: false
            }
          },
          correct: (
            if $actionable then {
              mode: "correct",
              instructions: "Return correction JSON.",
              input: {
                command: "missing-command",
                captured_output: "",
                captured_output_correlated_to_command: false
              }
            } else null end
          )
        },
        provider: [$zsh, $script, "provider", $provider_mode],
        codex_ask_engine: null,
        model: "gpt-5.3-codex-spark",
        reasoning: "low",
        models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
        reasoning_levels: ["low", "medium", "high"],
        context: {
          text: "",
          source: "none",
          label: "unavailable",
          correlated: false,
          included: $included
        },
        actionable_failure: $actionable,
        last_command: {
          command: "pwd",
          cwd: $cwd,
          exit_status: 0,
          pipeline_statuses: [0]
        }
      }
    ' > "$session_path" ||
    fail "could not create PTY session"
}

make_setup_session() {
  local session_path=$1
  make_session "$session_path" fast ask
  jq --arg provider "${SCRIPT_PATH:h:h}/src/codex-provider.zsh" '
    .provider = [$provider] |
    .provider_source = "default" |
    .provider_id = null |
    .codex_ask_engine = "exec"
  ' "$session_path" > "$session_path.tmp" || fail "could not create Setup session"
  command mv -- "$session_path.tmp" "$session_path"
}

run_endpoint_gate_cases() {
  local width ascii pane socket session_file result_file state_dir transcript provider_log screen
  local -i row col
  endpoint_wait() {
    local wanted=$1
    repeat 120; do
      pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
      [[ $pane == *"$wanted"* ]] && return 0
      command sleep 0.1
    done
    fail "endpoint ${width}/${ascii}: missing $wanted"
  }
  endpoint_click() {
    local label=$1 line
    local -a lines
    lines=("${(@f)pane}")
    row=0
    for line in "${lines[@]}"; do
      (( row += 1 ))
      if [[ $line == *"$label"* ]]; then
        col=$(( ${#${line%%${label}*}} + 2 ))
        TMUX='' command tmux -S "$socket" send-keys -l -- $'\e[<0;'"$col;$row"'M'
        TMUX='' command tmux -S "$socket" send-keys -l -- $'\e[<0;'"$col;$row"'m'
        return
      fi
    done
    fail "endpoint: pointer label missing"
  }
  endpoint_open() {
    TMUX='' command tmux -S "$socket" send-keys C-x s
    endpoint_wait 'Search All:'
    TMUX='' command tmux -S "$socket" send-keys -l 'configure local'
    endpoint_wait 'Configure local endpoint'
    endpoint_click 'Configure local endpoint'
    endpoint_wait 'Local endpoint /'
  }
  for width in 80 100 140; do
    for ascii in 0 1; do
      socket=$TEST_DIR/endpoint-$width-$ascii.sock
      session_file=$TEST_DIR/endpoint-$width-$ascii.json
      result_file=$TEST_DIR/endpoint-$width-$ascii-result.json
      state_dir=$TEST_DIR/endpoint-$width-$ascii-state
      transcript=$TEST_DIR/endpoint-$width-$ascii.typescript
      provider_log=$TEST_DIR/endpoint-$width-$ascii-provider.jsonl
      screen=$TEST_DIR/endpoint-$width-$ascii-screen.txt
      make_session "$session_file" fast generate
      PTY_TMUX_SOCKET=$socket
      TMUX='' command tmux -f /dev/null -S "$socket" new-session -d -x "$width" -y 40 \
        "env -u SHELLQ_LOCAL_OPENAI_ENDPOINT NO_UNICODE=$ascii SHELLQ_STATE_DIR=${(q)state_dir} SHELLQ_PTY_START_COLS=$width SHELLQ_PTY_CASE=endpoint SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)session_file} SHELLQ_PTY_RESULT=${(q)result_file} SHELLQ_PTY_PROVIDER_LOG=${(q)provider_log} ${(q)PTY_SCRIPT} ${(q)transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" || fail 'endpoint: could not start isolated PTY'
      endpoint_wait '[Command]'
      TMUX='' command tmux -S "$socket" send-keys -l ' retained-draft'
      endpoint_wait 'retained-draft'
      endpoint_open
      TMUX='' command tmux -S "$socket" send-keys C-a C-k
      TMUX='' command tmux -S "$socket" send-keys -l 'http://127.0.0.1:1/v1'
      endpoint_wait 'http://127.0.0.1:1/v1'
      TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
      if (( ascii == 0 )); then assert_frame_edges "$screen" "$width" 8; fi
      TMUX='' command tmux -S "$socket" send-keys Enter Tab C-x n
      endpoint_wait 'Local endpoint /'
      [[ ! -e $state_dir/settings.json && ! -e $result_file && ! -s $provider_log ]] || fail 'endpoint: modal input sent or saved'
      TMUX='' command tmux -S "$socket" send-keys C-x w
      endpoint_wait 'retained-draft'
      jq -e '.localEndpoint == "http://127.0.0.1:1/v1" and .providers == {}' "$state_dir/settings.json" >/dev/null || fail 'endpoint: keyboard save did not persist independently'
      endpoint_open
      endpoint_click '[Esc Discard]'
      endpoint_wait 'retained-draft'
      endpoint_open
      endpoint_click '[^X R Reset]'
      endpoint_wait 'retained-draft'
      jq -e 'has("localEndpoint") | not' "$state_dir/settings.json" >/dev/null || fail 'endpoint: pointer reset did not remove field'
      [[ ! -e $result_file && ! -s $provider_log ]] || fail 'endpoint: configuration sent a request or wrote a result'
      TMUX='' command tmux -S "$socket" send-keys C-c
      endpoint_wait 'TTY_RESTORED'
      assert_main_screen "$transcript"
      TMUX='' command tmux -S "$socket" kill-server
      PTY_TMUX_SOCKET=''
      print -r -- "PASS endpoint PTY ${width} columns ASCII=$ascii"
    done
  done
}

if [[ ${1:-} == endpoint-only ]]; then
  run_endpoint_gate_cases
  exit 0
fi

typeset inert_session=$TEST_DIR/inert-session.json
typeset inert_result=$TEST_DIR/inert-result.json
typeset inert_log=$TEST_DIR/inert-provider.jsonl
typeset inert_transcript=$TEST_DIR/inert.typescript
make_session "$inert_session" fast ask

typeset setup_bin=$TEST_DIR/setup-bin
typeset setup_state=$TEST_DIR/setup-state
typeset setup_marker_codex=$TEST_DIR/setup-codex-called
typeset setup_marker_claude=$TEST_DIR/setup-claude-called
typeset setup_session=$TEST_DIR/setup-session.json
typeset setup_selection_session=$TEST_DIR/setup-selection-session.json
typeset setup_second_session=$TEST_DIR/setup-second-session.json
typeset setup_result=$TEST_DIR/setup-result.json
typeset setup_second_result=$TEST_DIR/setup-second-result.json
typeset setup_transcript=$TEST_DIR/setup.typescript
typeset setup_second_transcript=$TEST_DIR/setup-second.typescript
mkdir -p -- "$setup_bin" "$setup_state"
make_setup_session "$setup_session"

# With neither CLI on PATH the bundled local provider stays selectable, so the
# workbench mounts on Local; Ctrl-X P still reaches Provider Setup.
{
  command sleep 1
  print -rn -- $'\x18p'
  command sleep 0.5
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-setup-recovery
} |
  SHELLQ_PTY_CASE=setup-recovery \
  SHELLQ_CODEX_MODEL=gpt-5.3-codex-spark \
  SHELLQ_PTY_PATH="$setup_bin:/usr/bin:/bin" \
  SHELLQ_PTY_BUN="$BUN_BIN" \
  SHELLQ_STATE_DIR="$setup_state" \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$setup_session \
  SHELLQ_PTY_RESULT=$setup_result \
  "$PTY_SCRIPT" "$setup_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Setup recovery PTY case failed"

assert_restored "$setup_transcript" after-setup-recovery
contains "$setup_transcript" 'Local' ||
  fail "Setup recovery did not mount the local provider"
contains "$setup_transcript" 'Provider Setup' ||
  fail "Setup recovery could not open Provider Setup"
contains "$setup_transcript" 'Codex CLI UNAVAILABLE' ||
  fail "Setup recovery did not show Codex unavailable"
contains "$setup_transcript" 'Claude CLI UNAVAILABLE' ||
  fail "Setup recovery did not show Claude unavailable"

print -r -- '#!/bin/sh' > "$setup_bin/codex"
print -r -- "printf called > ${(q)setup_marker_codex}" >> "$setup_bin/codex"
print -r -- '#!/bin/sh' > "$setup_bin/claude"
print -r -- "printf called > ${(q)setup_marker_claude}" >> "$setup_bin/claude"
command chmod 700 "$setup_bin/codex" "$setup_bin/claude"
make_setup_session "$setup_selection_session"

{
  command sleep 1
  print -rn -- $'\x18p'
  command sleep 0.3
  print -rn -- $'\e[C'
  command sleep 0.3
  print -rn -- $'\e[B'
  command sleep 0.15
  print -rn -- $'\e[C'
  command sleep 0.15
  print -rn -- $'\e[C'
  command sleep 0.3
  print -rn -- $'\r'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-setup-selection
} |
  SHELLQ_PTY_CASE=setup-selection \
  SHELLQ_CODEX_MODEL=gpt-5.3-codex-spark \
  SHELLQ_PTY_PATH="$setup_bin:/usr/bin:/bin" \
  SHELLQ_PTY_BUN="$BUN_BIN" \
  SHELLQ_STATE_DIR="$setup_state" \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$setup_selection_session \
  SHELLQ_PTY_RESULT=$setup_result \
  "$PTY_SCRIPT" "$setup_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Setup selection PTY case failed"

assert_restored "$setup_transcript" after-setup-selection
contains "$setup_transcript" 'Provider Setup' ||
  fail "Setup selection did not mount the Provider Setup surface"
contains "$setup_transcript" 'Codex CLI AVAILABLE' ||
  fail "Setup selection did not show local Codex availability"
contains "$setup_transcript" 'Claude CLI AVAILABLE' ||
  fail "Setup selection did not show local Claude availability"
contains "$setup_transcript" '[claude]' ||
  fail "Setup keyboard selection did not choose Claude"
jq -e '.providers.claude.model == "claude-opus-5"' "$setup_state/settings.json" >/dev/null ||
  fail "Setup keyboard selection did not persist the model before dismissal"
[[ ! -e $setup_marker_codex && ! -e $setup_marker_claude ]] ||
  fail "Setup executed an inert provider canary"
jq -e '.provider == "claude" and .providers.claude.model == "claude-opus-5"' \
  "$setup_state/settings.json" >/dev/null ||
  fail "Setup did not persist the provider-scoped selection"

cp -- "$setup_selection_session" "$setup_second_session"

{
  command sleep 1
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-setup-second
} |
  SHELLQ_PTY_CASE=setup-second \
  SHELLQ_PTY_BUN="$BUN_BIN" \
  SHELLQ_PTY_PATH="$setup_bin:/usr/bin:/bin" \
  SHELLQ_CODEX_MODEL=gpt-5.3-codex-spark \
  SHELLQ_STATE_DIR="$setup_state" \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$setup_second_session \
  SHELLQ_PTY_RESULT=$setup_second_result \
  "$PTY_SCRIPT" "$setup_second_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Setup second-invocation PTY case failed"

assert_restored "$setup_second_transcript" after-setup-second
contains "$setup_second_transcript" 'claude' ||
  fail "second invocation did not render the saved provider"
contains "$setup_second_transcript" 'claude-opus-5' ||
  fail "second invocation did not render the saved model"
! contains "$setup_second_transcript" 'Provider Setup' ||
  fail "second persisted invocation reopened Setup unexpectedly"
[[ ! -e $setup_marker_codex && ! -e $setup_marker_claude ]] ||
  fail "second Setup invocation executed an inert provider canary"

{
  command sleep 1
  print -rn -- $'\x18d'
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- a
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- d
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- h
  command sleep 0.2
  print -rn -- $'\e'
  command sleep 0.15
  print -rn -- $'\t'
  command sleep 0.15
  print -rn -- $'\t'
  command sleep 0.15
  print -rn -- $'\e[Z'
  command sleep 0.15
  print -rn -- $'\e[Z'
  command sleep 0.15
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-inert-modes
} |
  SHELLQ_PTY_CASE=inert \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$inert_session \
  SHELLQ_PTY_RESULT=$inert_result \
  SHELLQ_PTY_PROVIDER_LOG=$inert_log \
  "$PTY_SCRIPT" "$inert_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "inert mode PTY case failed"

assert_restored "$inert_transcript" after-inert-modes
assert_main_screen "$inert_transcript"
assert_peak_height "$inert_transcript" 12
contains "$inert_transcript" SCROLLBACK_SENTINEL:inert ||
  fail "inert mode case lost its preceding terminal marker"
contains "$inert_transcript" '[Ask] · Command · Fix' ||
  fail "Ask mode was not visibly selected on the top border"
! contains "$inert_transcript" 'Enter ask' ||
  fail "the composer still shows a routine submit label"
! contains "$inert_transcript" 'Enter generate' ||
  fail "the composer still shows a routine submit label"
! contains "$inert_transcript" 'Enter fix' ||
  fail "the composer still shows a routine submit label"
contains "$inert_transcript" 'Actions · S settings · P provider · nothing sends · Esc close' ||
  fail "Ctrl-X did not open the action sheet"
contains "$inert_transcript" 'nothing sends' ||
  fail "action sheet did not preserve request inertness"
contains "$inert_transcript" '› cwd' ||
  fail "Ctrl-X H did not open details from the composer"
contains "$inert_transcript" 'PASS cwd' ||
  fail "Ctrl-X D did not open the local Doctor rows"
contains "$inert_transcript" 'PASS Ask pointer' ||
  fail "Doctor did not show its bounded Ask pointer row"
! contains "$inert_transcript" '^X: a another' ||
  fail "details duplicated the full key help instead of staying an inspector"
# The renderer repaints changed cells rather than whole rows, so a switched
# mode strip is not contiguous in the raw transcript. Mode switching is
# asserted on a settled screen in the ZLE geometry case below; here only the
# inertness of switching is checked.
# The action is asserted on the settled action-sheet screen in the ZLE
# geometry case; the raw transcript repaints cells, not whole rows.
! contains "$inert_transcript" 'repo no' ||
  fail "resting rail exposed an irrelevant negative repository default"
! contains "$inert_transcript" 'nothing sent' ||
  fail "resting rail exposed an irrelevant transmission default"
[[ ! -s $inert_log ]] ||
  fail "opening or switching modes invoked the provider"
[[ ! -e $inert_result ]] ||
  fail "inert mode switching created an accepted result"

typeset ask_session=$TEST_DIR/ask-session.json
typeset ask_result=$TEST_DIR/ask-result.json
typeset ask_log=$TEST_DIR/ask-provider.jsonl
typeset ask_transcript=$TEST_DIR/ask.typescript
make_session "$ask_session" long-answer ask

{
  command sleep 1
  print -rn -- 'what is'
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- e
  command sleep 0.2
  print -rn -- $'\e[13u'
  print -rn -- 'fixture?'
  print -rn -- $'\r'
  print -rn -- 'editor'
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- w
  command sleep 0.2
  print -rn -- $'\e[13;2u'
  print -rn -- 'shifted'
  print -rn -- $'\e[200~\n\npasted\e[201~'
  print -rn -- $'\r'
  command sleep 0.8
  repeat 15; do print -rn -- $'\e[B'
  done
  command sleep 0.3
  print -rn -- $'\e[A'
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- e
  command sleep 0.2
  print -rn -- ' again'
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- w
  command sleep 0.2
  print -rn -- $'\r'
  command sleep 0.8
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-ask
} |
  SHELLQ_PTY_CASE=ask \
  SHELLQ_PTY_START_COLS=100 \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$ask_session \
  SHELLQ_PTY_RESULT=$ask_result \
  SHELLQ_PTY_PROVIDER_LOG=$ask_log \
  "$PTY_SCRIPT" "$ask_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Ask PTY case failed"

assert_restored "$ask_transcript" after-ask
assert_main_screen "$ask_transcript"
assert_peak_height "$ask_transcript" 16
contains "$ask_transcript" SCROLLBACK_SENTINEL:ask ||
  fail "Ask case lost its preceding terminal marker"
contains "$ask_transcript" ASK_SCROLL_BOTTOM ||
  fail "long Ask answer did not scroll to its bottom marker"
contains "$ask_transcript" 'PTY_STREAM_PREVIEW_CANARY_604' ||
  fail "Ask preview did not render before the final answer"
jq -se '
  length == 2
  and .[0].mode == "ask"
  and .[0].input.query == "what is\nfixture?\neditor\nshifted\n\npasted"
  and .[1].input.query == "what is\nfixture?\neditor\nshifted\n\npasted again"
' "$ask_log" >/dev/null ||
  fail "prompt editor, Shift-Enter, or paste did not preserve the multiline question"
[[ ! -e $ask_result ]] ||
  fail "Ask answer created an accepted command result"

typeset context_session=$TEST_DIR/context-session.json
typeset context_result=$TEST_DIR/context-result.json
typeset context_log=$TEST_DIR/context-provider.jsonl
typeset context_transcript=$TEST_DIR/context.typescript
typeset context_auto_exec=$TEST_DIR/context-auto-executed
make_session "$context_session" fast generate true

{
  command sleep 1
  print -rn -- $'\r'
  command sleep 0.8
  print -rn -- $'\e[6~'
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- e
  command sleep 0.2
  print -rn -- $'\e[13u'
  print -rn -- 'echo edited'
  print -rn -- $'\r'
  print -rn -- 'echo raw-enter'
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- w
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- c
  command sleep 0.2
  print -rn -- 'manual context'
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- w
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- i
  command sleep 0.1
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- a
  command sleep 0.8
  print -rn -- $'\e[A'
  command sleep 0.15
  print -rn -- $'\e[B'
  command sleep 0.15
  print -rn -- $'\e[D'
  command sleep 0.15
  print -rn -- $'\e[C'
  command sleep 0.15
  print -rn -- $'\e[A'
  command sleep 0.15
  print -rn -- $'\r\e'
  command sleep 0.3
  print -r -- after-accept
} |
  SHELLQ_PTY_CASE=context \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$context_session \
  SHELLQ_PTY_RESULT=$context_result \
  SHELLQ_PTY_PROVIDER_LOG=$context_log \
  SHELLQ_PTY_AUTO_EXEC_FILE=$context_auto_exec \
  "$PTY_SCRIPT" "$context_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "context PTY case failed"

assert_restored "$context_transcript" after-accept
assert_main_screen "$context_transcript"
assert_peak_height "$context_transcript" 12 16
contains "$context_transcript" SCROLLBACK_SENTINEL:context ||
  fail "context case lost its preceding terminal marker"
jq -se --arg edited $'touch '"$context_auto_exec"$'-1\necho edited\necho raw-enter' '
  length == 2
  and .[0].input.captured_output == ""
  and .[1].input.captured_output == "manual context"
  and .[1].input.avoid_commands == [$edited]
' "$context_log" >/dev/null ||
  fail "saved context was not kept out until explicit inclusion"
contains "$context_transcript" '1  touch ' ||
  fail "first vertical candidate was not visible"
contains "$context_transcript" SCROLL_DESCRIPTION_BOTTOM ||
  fail "candidate description did not wrap and scroll above the commands"
contains "$context_transcript" 'insert (never runs)' ||
  fail "the candidate surface hid its review-only insertion label"
jq -e --arg command $'touch '"$context_auto_exec"$'-1\necho edited\necho raw-enter' \
  '.corrected_command == $command' "$context_result" >/dev/null ||
  fail "multiline candidate edit or candidate navigation selected the wrong result"
contains "$context_transcript" 'echo edited' ||
  fail "the selected multiline candidate was not rendered on separate rows"
[[ ! -e ${context_auto_exec}-1 && ! -e ${context_auto_exec}-2 ]] ||
  fail "a reviewed candidate executed automatically"

typeset no_safe_session=$TEST_DIR/no-safe-session.json
typeset no_safe_result=$TEST_DIR/no-safe-result.json
typeset no_safe_log=$TEST_DIR/no-safe-provider.jsonl
typeset no_safe_transcript=$TEST_DIR/no-safe.typescript
make_session "$no_safe_session" no-safe correct true true

{
  command sleep 1
  print -rn -- $'\r'
  typeset -i attempt
  for attempt in {1..80}; do
    [[ -e $no_safe_transcript ]] &&
      contains "$no_safe_transcript" intended && break
    command sleep 0.05
  done
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-no-safe
} |
  SHELLQ_PTY_CASE=no-safe \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$no_safe_session \
  SHELLQ_PTY_RESULT=$no_safe_result \
  SHELLQ_PTY_PROVIDER_LOG=$no_safe_log \
  "$PTY_SCRIPT" "$no_safe_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "no-safe PTY case failed"

assert_restored "$no_safe_transcript" after-no-safe
assert_main_screen "$no_safe_transcript"
assert_peak_height "$no_safe_transcript" 8
contains "$no_safe_transcript" intended ||
  fail "null correction did not show its TLDR above the preserved composer"
[[ ! -e $no_safe_result ]] ||
  fail "null correction created an accepted result"

typeset failure_session=$TEST_DIR/failure-session.json
typeset failure_result=$TEST_DIR/failure-result.json
typeset failure_transcript=$TEST_DIR/failure.typescript
make_session "$failure_session" failure generate

{
  command sleep 1
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-failure
} |
  OTUI_USE_ALTERNATE_SCREEN=1 \
  OTUI_OVERRIDE_STDOUT=0 \
  SHELLQ_PTY_CASE=failure \
  SHELLQ_PTY_RESIZE_COLS=100 \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$failure_session \
  SHELLQ_PTY_RESULT=$failure_result \
  "$PTY_SCRIPT" "$failure_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "failure PTY case failed"

assert_restored "$failure_transcript" after-failure
assert_main_screen "$failure_transcript"
assert_peak_height "$failure_transcript" 3
contains "$failure_transcript" SCROLLBACK_SENTINEL:failure ||
  fail "failure case lost its preceding terminal marker"
! contains "$failure_transcript" $'\u009b' ||
  fail "provider stderr exposed a C1 terminal control"
[[ ! -e $failure_result ]] ||
  fail "provider failure created an accepted result"

typeset escape_session=$TEST_DIR/escape-session.json
typeset escape_result=$TEST_DIR/escape-result.json
typeset escape_pid_file=$TEST_DIR/escape-provider.pid
typeset escape_transcript=$TEST_DIR/escape.typescript
make_session "$escape_session" slow generate

{
  command sleep 1
  print -rn -- $'\r'
  repeat 60; do
    [[ -s $escape_pid_file ]] && break
    command sleep 0.05
  done
  print -rn -- $'\e'
  repeat 60; do
    if [[ -s $escape_pid_file ]]; then
      typeset -i provider_pid=$(<"$escape_pid_file")
      ! kill -0 "$provider_pid" 2>/dev/null && break
    fi
    command sleep 0.05
  done
  command sleep 0.5
  print -rn -- $'\t'
  command sleep 0.2
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-escape-cancel
} |
  SHELLQ_PTY_CASE=escape \
  SHELLQ_PTY_START_COLS=140 \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$escape_session \
  SHELLQ_PTY_RESULT=$escape_result \
  SHELLQ_PTY_PROVIDER_PID=$escape_pid_file \
  "$PTY_SCRIPT" "$escape_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Escape-cancellation PTY case failed"

assert_restored "$escape_transcript" after-escape-cancel
assert_main_screen "$escape_transcript"
assert_peak_height "$escape_transcript" 3
contains "$escape_transcript" SCROLLBACK_SENTINEL:escape ||
  fail "Escape-cancellation case lost its preceding terminal marker"
# Incremental cell repaints split rail labels across cursor moves, so match the
# distinctive word rather than the whole `Enter retry` action.
contains "$escape_transcript" 'retry' ||
  fail "Escape did not return the workbench to an interactive cancelled state"
[[ -s $escape_pid_file ]] ||
  fail "Escape-cancellation provider did not start"
typeset -i escape_pid=$(<"$escape_pid_file")
! kill -0 "$escape_pid" 2>/dev/null ||
  fail "Escape left the provider running"
[[ ! -e $escape_result ]] ||
  fail "Escape cancellation created an accepted result"

typeset slow_session=$TEST_DIR/slow-session.json
typeset slow_result=$TEST_DIR/slow-result.json
typeset slow_pid_file=$TEST_DIR/slow-provider.pid
typeset slow_transcript=$TEST_DIR/slow.typescript
make_session "$slow_session" slow generate

{
  command sleep 1
  print -rn -- $'\r'
  repeat 60; do
    [[ -s $slow_pid_file ]] && break
    command sleep 0.05
  done
  print -rn -- $'\x03'
  command sleep 0.4
  print -r -- after-interrupt
} |
  SHELLQ_PTY_CASE=interrupt \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$slow_session \
  SHELLQ_PTY_RESULT=$slow_result \
  SHELLQ_PTY_PROVIDER_PID=$slow_pid_file \
  "$PTY_SCRIPT" "$slow_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "interrupt PTY case failed"

assert_restored "$slow_transcript" after-interrupt
assert_main_screen "$slow_transcript"
assert_peak_height "$slow_transcript" 3
[[ -s $slow_pid_file ]] ||
  fail "slow provider did not start"
typeset -i slow_pid=$(<"$slow_pid_file")
repeat 40; do
  kill -0 "$slow_pid" 2>/dev/null || break
  command sleep 0.05
done
! kill -0 "$slow_pid" 2>/dev/null ||
  fail "Ctrl-C left the provider running"
[[ ! -e $slow_result ]] ||
  fail "Ctrl-C created an accepted result"

(( $+commands[tmux] )) || fail "tmux is required for the ZLE geometry check"

run_zle_geometry_case() {
  local label=$1
  local -i context_lines=$2
  local socket=$TEST_DIR/tmux-$label.sock
  local transcript=$TEST_DIR/zle-$label.typescript
  local before_screen=$TEST_DIR/zle-$label-before-screen.txt
  local before_history=$TEST_DIR/zle-$label-before-history.txt
  local screen=$TEST_DIR/zle-$label-screen.txt
  local history=$TEST_DIR/zle-$label-history.txt
  local compact_screen=$TEST_DIR/zle-$label-compact-screen.txt
  local action_screen=$TEST_DIR/zle-$label-action-screen.txt
  local details_screen=$TEST_DIR/zle-$label-details-screen.txt
  local promoted_screen=$TEST_DIR/zle-$label-promoted-screen.txt
  local marker=ZLE_HISTORY_MARKER_${label:u}
  local context_prefix=ZLE_CONTEXT_${label:u}_
  local live=ZLE_TERMINAL_LIVE_${label:u}
  local pane='' setup fixture_command expected border cleanup_sequence='' cleanup_row=unknown
  local -i prompt_count_before=0 prompt_count_after=0
  local -i prompt_row_before=0 prompt_row_after=0
  local -i marker_row_after=0 history_prompt_row_after=0 line_number=0
  local -i context_row_before=0 marker_row_before=0 history_prompt_row_before=0
  local -i context_row_after=0
  local -i top_rail_row=0 composer_row=0 bottom_rail_row=0
  local -i action_row=0 detail_row=0
  local -i expected_cleanup_row=0

  PTY_TMUX_SOCKET=$socket
  TMUX='' command tmux -f /dev/null -S "$socket" new-session -d -x 80 -y 40 \
    "${(q)PTY_SCRIPT} ${(q)transcript} ${(q)ZSH_BIN} -dfi" ||
    fail "$label: could not start isolated 80x40 zsh PTY"
  [[ $(TMUX='' command tmux -S "$socket" display-message -p \
    '#{pane_width}x#{pane_height}') == 80x40 ]] ||
    fail "$label: isolated zsh PTY did not retain 80x40 geometry"

  setup="PS1='ZAI_GEOMETRY_PROMPT> '; RPROMPT=''; SHELLQ_PROVIDER=(/usr/bin/true); source ${(q)PLUGIN}; read() { (( \${argv[(I)R]} )) && command sleep 0.05; builtin read \"\$@\"; }; clear"
  TMUX='' command tmux -S "$socket" send-keys -l -- "$setup"
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ ${pane##*$'\n'} == 'ZAI_GEOMETRY_PROMPT>'* ]] && break
    command sleep 0.05
  done
  [[ ${pane##*$'\n'} == 'ZAI_GEOMETRY_PROMPT>'* ]] ||
    fail "$label: isolated zsh did not reach its initial prompt"
  fixture_command="print -r -- $marker"
  if (( context_lines > 0 )); then
    fixture_command="print -rl -- ZLE_CONTEXT_${label:u}_{01..${context_lines}}; $fixture_command"
  fi
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    "$fixture_command"
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *$marker* &&
       ${pane##*$'\n'} == 'ZAI_GEOMETRY_PROMPT>'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *$marker* &&
     ${pane##*$'\n'} == 'ZAI_GEOMETRY_PROMPT>'* ]] ||
    fail "$label: geometry fixture did not finish rendering"
  TMUX='' command tmux -S "$socket" capture-pane -p > "$before_screen"
  TMUX='' command tmux -S "$socket" capture-pane -p -S - -E - > \
    "$before_history"
  read -r prompt_count_before prompt_row_before < <(command awk '
    /ZAI_GEOMETRY_PROMPT>/ { count++; row = NR }
    END { print count + 0, row + 0 }
  ' "$before_screen")
  read -r context_row_before marker_row_before history_prompt_row_before \
    < <(command awk -v context="$context_prefix" -v marker="$marker" '
      index($0, context) { context_row = NR }
      index($0, marker) { marker_row = NR }
      /ZAI_GEOMETRY_PROMPT>/ { prompt_row = NR }
      END { print context_row + 0, marker_row + 0, prompt_row + 0 }
    ' "$before_history")
  (( prompt_count_before > 0 )) ||
    fail "$label: geometry fixture did not render a prompt"
  if [[ $label == top ]]; then
    (( prompt_row_before <= 6 )) ||
      fail "$label: fixture prompt was not near the top (row $prompt_row_before)"
  else
    (( prompt_row_before == 40 )) ||
      fail "$label: fixture prompt was not at the bottom (row $prompt_row_before)"
  fi

  TMUX='' command tmux -S "$socket" send-keys C-o
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'╭─[Ask] · Command · Fix'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'╭─[Ask] · Command · Fix'* ]] ||
    fail "$label: Ctrl-O did not open the workbench"
  [[ $pane != *'^[['* ]] ||
    fail "$label: cursor-position reply leaked onto the screen"

  TMUX='' command tmux -S "$socket" capture-pane -p > "$compact_screen"
  read -r top_rail_row composer_row bottom_rail_row < <(command awk '
    index($0, "╭─[Ask]") { top = NR }
    index($0, "Ask about this repo") { composer = NR }
    index($0, "^X") { bottom = NR }
    END { print top + 0, composer + 0, bottom + 0 }
  ' "$compact_screen")
  (( top_rail_row > 0 && composer_row == top_rail_row + 1 &&
     bottom_rail_row == composer_row + 1 )) ||
    fail "$label: initial frame was not exactly three contiguous rows ($top_rail_row,$composer_row,$bottom_rail_row)"
  assert_frame_edges "$compact_screen" 80 3
  contains "$compact_screen" 'Ask' && contains "$compact_screen" 'Command' &&
    contains "$compact_screen" 'Fix' ||
    fail "$label: the top border did not name all three modes"
  ! contains "$compact_screen" 'Enter ask' ||
    fail "$label: the composer still shows a routine submit label"

  # Selection must be legible from the bracket alone, on a settled screen.
  TMUX='' command tmux -S "$socket" send-keys Tab
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Ask · [Command] · Fix'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Ask · [Command] · Fix'* ]] ||
    fail "$label: Tab did not bracket Command while still showing every mode"
  TMUX='' command tmux -S "$socket" send-keys Tab
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Ask · Command · [Fix]' ]] && break
    [[ $pane == *'Ask · Command · [Fix]'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Ask · Command · [Fix]'* ]] ||
    fail "$label: Tab did not bracket Fix while still showing every mode"
  TMUX='' command tmux -S "$socket" send-keys BTab
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Ask · [Command] · Fix'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys BTab
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'[Ask] · Command · Fix'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'[Ask] · Command · Fix'* ]] ||
    fail "$label: Shift-Tab did not cycle back to Ask"
  if [[ $label == bottom ]]; then
    (( top_rail_row == 38 && composer_row == 39 && bottom_rail_row == 40 )) ||
      fail "$label: three-row rail was not bottom-pinned ($top_rail_row-$bottom_rail_row)"

    TMUX='' command tmux -S "$socket" send-keys C-x
    repeat 80; do
      pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
      [[ $pane == *'Actions · S settings · P provider · nothing sends · Esc close'* ]] && break
      command sleep 0.05
    done
    [[ $pane == *'Actions · S settings · P provider · nothing sends · Esc close'* ]] ||
      fail "$label: Ctrl-X did not reveal the action sheet"
    repeat 80; do
      TMUX='' command tmux -S "$socket" capture-pane -p > "$action_screen"
      read -r top_rail_row action_row bottom_rail_row < <(command awk '
        index($0, "╭─[Ask]") { top = NR }
        index($0, "Actions · S settings · P provider · nothing sends · Esc close") { action = NR }
        index($0, "^X") { bottom = NR }
        END { print top + 0, action + 0, bottom + 0 }
      ' "$action_screen")
      (( top_rail_row == 33 && action_row == 34 && bottom_rail_row == 40 )) &&
        break
      command sleep 0.05
    done
    (( top_rail_row == 33 && action_row == 34 && bottom_rail_row == 40 )) ||
      fail "$label: action sheet did not promote the footer to rows 33-40 ($top_rail_row,$action_row,$bottom_rail_row)"
    assert_frame_edges "$action_screen" 80 8
    contains "$action_screen" 'Esc back' ||
      fail "$label: the action sheet did not show its contextual back action"

    TMUX='' command tmux -S "$socket" send-keys -l -- h
    repeat 80; do
      pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
      [[ $pane == *'› cwd'* ]] && break
      command sleep 0.05
    done
    [[ $pane == *'› cwd'* ]] ||
      fail "$label: action H did not open trusted details"
    repeat 80; do
      TMUX='' command tmux -S "$socket" capture-pane -p > "$details_screen"
      read -r top_rail_row detail_row bottom_rail_row < <(command awk '
        index($0, "╭─[Ask]") { top = NR }
        index($0, "› cwd") { detail = NR }
        index($0, "^X") { bottom = NR }
        END { print top + 0, detail + 0, bottom + 0 }
      ' "$details_screen")
      (( top_rail_row == 29 && detail_row == 30 && bottom_rail_row == 40 )) &&
        break
      command sleep 0.05
    done
    (( top_rail_row == 29 && detail_row == 30 && bottom_rail_row == 40 )) ||
      fail "$label: details did not promote the footer to rows 29-40 ($top_rail_row,$detail_row,$bottom_rail_row)"
    assert_frame_edges "$details_screen" 80 12
    ! contains "$details_screen" '^X: a another' ||
      fail "$label: details duplicated the full key help instead of staying an inspector"

    TMUX='' command tmux -S "$socket" send-keys Escape
    repeat 80; do
      pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
      [[ $pane == *'Ask about this repo'* && $pane == *'╭─[Ask]'* ]] && break
      command sleep 0.05
    done
    [[ $pane == *'Ask about this repo'* && $pane == *'╭─[Ask]'* ]] ||
      fail "$label: details did not return to the main workbench"
    repeat 80; do
      TMUX='' command tmux -S "$socket" capture-pane -p > "$promoted_screen"
      read -r top_rail_row composer_row bottom_rail_row < <(command awk '
        index($0, "╭─[Ask]") { top = NR }
        index($0, "Ask about this repo") { composer = NR }
        index($0, "^X") { bottom = NR }
        END { print top + 0, composer + 0, bottom + 0 }
      ' "$promoted_screen")
      (( top_rail_row == 29 && composer_row == 39 && bottom_rail_row == 40 )) &&
        break
      command sleep 0.05
    done
    (( top_rail_row == 29 && composer_row == 39 && bottom_rail_row == 40 )) ||
      fail "$label: footer shrank after 12-row promotion ($top_rail_row,$composer_row,$bottom_rail_row)"
    assert_frame_edges "$promoted_screen" 80 12
  fi

  TMUX='' command tmux -S "$socket" send-keys Escape
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'ZAI_GEOMETRY_PROMPT>'* &&
       $pane != *'╭─[Ask]'* && $pane != *'Actions ·'* ]] && break
    command sleep 0.05
  done

  TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
  TMUX='' command tmux -S "$socket" capture-pane -p -S - -E - > "$history"
  read -r context_row_after marker_row_after history_prompt_row_after \
    < <(command awk -v context="$context_prefix" -v marker="$marker" '
      index($0, context) { context_row = NR }
      index($0, marker) { marker_row = NR }
      /ZAI_GEOMETRY_PROMPT>/ { prompt_row = NR }
      END { print context_row + 0, marker_row + 0, prompt_row + 0 }
    ' "$history")
  cleanup_sequence=$(LC_ALL=C command grep -aoE \
    $'\e\\[[0-9]+;1H\e\\[J' "$transcript" | command tail -1)
  if [[ -n $cleanup_sequence ]]; then
    cleanup_row=${cleanup_sequence#$'\e['}
    cleanup_row=${cleanup_row%%;*}
  fi
  expected_cleanup_row=$(( prompt_row_before + 1 ))
  if [[ $label == bottom ]] && (( expected_cleanup_row > 28 )); then
    expected_cleanup_row=28
  fi
  [[ $cleanup_row == $expected_cleanup_row ]] ||
    fail "$label: cleanup used row $cleanup_row, expected $expected_cleanup_row from the finalized peak"
  contains "$history" "$marker" ||
    fail "$label: lost history marker (context $context_row_before->$context_row_after, marker $marker_row_before->$marker_row_after, prompt $history_prompt_row_before->$history_prompt_row_after, cleanup CUP row $cleanup_row)"
  for (( line_number = 1; line_number <= context_lines; line_number++ )); do
    printf -v expected 'ZLE_CONTEXT_%s_%02d' "${label:u}" "$line_number"
    contains "$history" "$expected" ||
      fail "$label: workbench close lost context line $expected"
  done
  read -r prompt_count_after prompt_row_after < <(command awk '
    /ZAI_GEOMETRY_PROMPT>/ { count++; row = NR }
    END { print count + 0, row + 0 }
  ' "$screen")
  (( prompt_count_after > 0 && prompt_count_after <= prompt_count_before )) ||
    fail "$label: workbench close left an invalid prompt count ($prompt_count_before before, $prompt_count_after after)"
  (( marker_row_after > 0 &&
     history_prompt_row_after == marker_row_after + 1 )) ||
    fail "$label: workbench close left a gap between marker row $marker_row_after and prompt row $history_prompt_row_after"
  ! contains "$screen" '╭─[Ask]' ||
    fail "$label: workbench close left the frame on the main screen"

  TMUX='' command tmux -S "$socket" send-keys -l -- "print -r -- $live"
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 40; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p -S -100)
    [[ $pane == *$live* ]] && break
    command sleep 0.05
  done
  [[ $pane == *$live* ]] ||
    fail "$label: terminal did not accept input after workbench close"

  TMUX='' command tmux -S "$socket" send-keys C-d
  command sleep 0.2
  assert_main_screen "$transcript"
  TMUX='' command tmux -S "$socket" kill-server 2>/dev/null
  PTY_TMUX_SOCKET=''
}

run_zle_geometry_case top 0
run_zle_geometry_case bottom 36

typeset settings_session=$TEST_DIR/settings-session.json
typeset settings_state=$TEST_DIR/settings-state
typeset settings_result=$TEST_DIR/settings-result.json
typeset settings_log=$TEST_DIR/settings-provider.jsonl
typeset settings_transcript=$TEST_DIR/settings.typescript
make_session "$settings_session" fast generate
mkdir -p -- "$settings_state"

{
  command sleep 1
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- s
  command sleep 0.3
  print -rn -- lun
  command sleep 0.2
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- high
  command sleep 0.2
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- s
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- s
  command sleep 0.3
  print -rn -- doctor
  command sleep 0.2
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- s
  command sleep 0.3
  print -rn -- another
  command sleep 0.2
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-settings
} |
  NO_UNICODE=1 \
  SHELLQ_PTY_CASE=settings \
  SHELLQ_STATE_DIR=$settings_state \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$settings_session \
  SHELLQ_PTY_RESULT=$settings_result \
  SHELLQ_PTY_PROVIDER_LOG=$settings_log \
  "$PTY_SCRIPT" "$settings_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Settings PTY case failed"

assert_restored "$settings_transcript" after-settings
assert_main_screen "$settings_transcript"
assert_peak_height "$settings_transcript" 12
contains "$settings_transcript" SCROLLBACK_SENTINEL:settings ||
  fail "Settings case lost its preceding terminal marker"
contains "$settings_transcript" 'Luna' ||
  fail "Ctrl-X S did not filter or apply the Luna model"
contains "$settings_transcript" 'PASS cwd' ||
  fail "the universal palette did not open the local Doctor surface"
contains "$settings_transcript" 'Actions · S settings' ||
  fail "Another did not route to the ASCII Actions surface"
! contains "$settings_transcript" '╭' ||
  fail "the focused settings workflow ignored the ASCII override"
! contains "$settings_transcript" '→' ||
  fail "the focused settings workflow emitted a Unicode effect arrow"
! contains "$settings_transcript" "$SCRIPT_PATH" ||
  fail "the universal palette exposed the configured provider path"
! contains "$settings_transcript" 'provider fast' ||
  fail "the universal palette exposed configured provider argv"
contains "$settings_transcript" '^X actions' ||
  fail "closing Settings did not return to the resting rail"
[[ ! -s $settings_log ]] ||
  fail "opening or changing Settings invoked the provider"
[[ ! -e $settings_result ]] ||
  fail "Settings created an accepted result"
jq -e '
  .version == 2 and
  .provider == "codex" and
  .providers.configured.model == "gpt-5.6-luna" and
  .providers.configured.reasoning == "high"
' "$settings_state/settings.json" >/dev/null ||
  fail "Settings did not persist Luna/High under the temporary state root"
[[ $(find "$settings_state" -type f | command wc -l | command tr -d ' ') -eq 1 ]] ||
  fail "Settings wrote unexpected files under the temporary state root"

typeset settings_draft_session=$TEST_DIR/settings-draft-session.json
typeset settings_draft_result=$TEST_DIR/settings-draft-result.json
typeset settings_draft_log=$TEST_DIR/settings-draft-provider.jsonl
typeset settings_draft_transcript=$TEST_DIR/settings-draft.typescript
make_session "$settings_draft_session" fast generate

# A raw-transcript substring match proves nothing about restoration: typed
# text is echoed to the screen (and so lands in the transcript) well before
# Settings ever opens, so it "survives" in the transcript even if the
# restore effect drops it. This case instead ACTS on the restored value —
# submits the restored composer draft and inspects the exact JSON the
# provider received; saves the restored command edit and inspects the
# accepted candidate — so a broken restore fails the assertion, not just a
# `contains` check on stale screen output.
{
  command sleep 1
  print -rn -- 'unsaved draft'
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- m
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\r'
  command sleep 0.8
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- e
  command sleep 0.2
  print -rn -- ' --extra'
  command sleep 0.2
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- r
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- a
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\x18'
  command sleep 0.05
  print -rn -- w
  command sleep 0.3
  print -rn -- $'\r'
  command sleep 0.5
  print -rn -- $'\e'
  command sleep 0.3
  print -rn -- $'\e'
  command sleep 0.3
  print -r -- after-settings-draft
} |
  SHELLQ_PTY_CASE=settings-draft \
  SHELLQ_PTY_WORKBENCH=$WORKBENCH \
  SHELLQ_PTY_WORKDIR=$TEST_DIR \
  SHELLQ_PTY_SESSION=$settings_draft_session \
  SHELLQ_PTY_RESULT=$settings_draft_result \
  SHELLQ_PTY_PROVIDER_LOG=$settings_draft_log \
  "$PTY_SCRIPT" "$settings_draft_transcript" \
    "$ZSH_BIN" "$SCRIPT_PATH" child >/dev/null ||
  fail "Settings draft-preservation PTY case failed"

assert_restored "$settings_draft_transcript" after-settings-draft
assert_main_screen "$settings_draft_transcript"
contains "$settings_draft_transcript" SCROLLBACK_SENTINEL:settings-draft ||
  fail "Settings draft case lost its preceding terminal marker"
[[ $(command wc -l < "$settings_draft_log") -eq 1 ]] ||
  fail "Ctrl-X A while Settings was open started a provider call"
jq -e '.input.command == "show current directoryunsaved draft"' "$settings_draft_log" >/dev/null ||
  fail "the composer draft submitted after closing Settings was not the restored value"
[[ -e $settings_draft_result ]] ||
  fail "opening and closing Settings while editing lost the unsaved command edit before Ctrl-X W could save it"
jq -e '.corrected_command == "echo suggestion-1 --extra"' "$settings_draft_result" >/dev/null ||
  fail "the accepted candidate did not carry the command edit made while Settings was open"

# The mouse gate: proves byte-level SGR delivery and the y-translation that
# only a real PTY can prove (`processSingleMouseEvent` never reads columns,
# so this is width-independent — 100/140 are covered by the pure-function
# span tests plus the manual wizard, per the plan). Built on tmux for
# reliable geometry (a bare /usr/bin/script here has no controlling
# terminal to inherit a size from) and `tmux send-keys -l --` for literal
# SGR byte injection — `send-keys -H` (hex) was measured NOT delivering SGR
# to the application; the raw-literal path was measured working.
open_pointer_action() {
  local socket=$1 suffix=$2 pane=''
  TMUX='' command tmux -S "$socket" send-keys C-x
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Actions ·'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Actions ·'* ]] || fail "pointer: Ctrl-X did not open Actions"
  TMUX='' command tmux -S "$socket" send-keys -l -- "$suffix"
}

close_pointer_palette() {
  local socket=$1 pane=''
  repeat 8; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    if [[ $pane != *'Search All:'* && $pane != *'Search Models:'* &&
      $pane != *'Search Effort:'* && $pane != *'Search Providers:'* &&
      $pane != *'Search Engines:'* && $pane != *'Search More:'* ]]; then
      return
    fi
    TMUX='' command tmux -S "$socket" send-keys Escape
    command sleep 0.1
  done
  fail "pointer: palette did not close"
}

run_pointer_gate_case() {
  local socket=$TEST_DIR/tmux-pointer.sock
  local transcript=$TEST_DIR/pointer.typescript
  local pointer_session=$TEST_DIR/pointer-session.json
  local pointer_result=$TEST_DIR/pointer-result.json
  local pointer_log=$TEST_DIR/pointer-provider.jsonl
  local pointer_state=$TEST_DIR/pointer-state
  local screen=$TEST_DIR/pointer-screen.txt
  local pane=''
  local -i top_row=0 click_col=0 click_row=0
  local -i candidate_top=0 candidate_1_row=0 model_four_row=0 model_five_row=0 pre_click_log=0

  make_session "$pointer_session" fast ask
  jq '.models += ["model-one", "model-two", "model-three", "model-four", "model-five", "model-six"]' \
    "$pointer_session" > "$pointer_session.tmp" || fail "pointer: could not extend the model fixture"
  command mv -- "$pointer_session.tmp" "$pointer_session"

  PTY_TMUX_SOCKET=$socket
  TMUX='' command tmux -f /dev/null -S "$socket" new-session -d -x 80 -y 40 \
    "SHELLQ_STATE_DIR=${(q)pointer_state} SHELLQ_PTY_CASE=pointer SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)pointer_session} SHELLQ_PTY_RESULT=${(q)pointer_result} SHELLQ_PTY_PROVIDER_LOG=${(q)pointer_log} ${(q)PTY_SCRIPT} ${(q)transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" ||
    fail "pointer: could not start the isolated 80x40 pointer PTY"

  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'╭─[Ask] · Command · Fix'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'╭─[Ask] · Command · Fix'* ]] ||
    fail "pointer: workbench did not render at 80x40"

  # 1. A click on a mode tab at the derived top-border row switches the
  #    bracket; the provider log is still empty.
  top_row=$(TMUX='' command tmux -S "$socket" capture-pane -p |
    command awk 'index($0, "╭─[Ask] · Command · Fix") { print NR }')
  (( top_row > 0 )) || fail "pointer: could not derive the compact band's top row"
  # "[Ask] · Command · Fix": Command's span starts at cell 8 (0-indexed);
  # TITLE_ORIGIN_X = 2 -> absolute column (1-indexed) = 2 + 8 + 1 = 11.
  click_col=11
  click_row=$top_row
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'M'
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'m'
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Ask · [Command] · Fix'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'Ask · [Command] · Fix'* ]] ||
    fail "pointer: clicking the Command tab did not switch modes"
  [[ ! -s $pointer_log ]] ||
    fail "pointer: the mode-tab click invoked the provider"

  # 1b. A non-left click (right-click, SGR button 2) on an inactive tab does
  #     not move the bracket — only button 0 (left) may act.
  # "Ask · [Command] · Fix": with Command selected, Fix's span starts at
  # cell 18 (0-indexed); TITLE_ORIGIN_X = 2 -> absolute column = 2+18+1=21.
  # Settle first: the composer's own effects can still be repainting a cell
  # or two right after the mode switch, which would otherwise read as a
  # false click effect.
  command sleep 0.3
  local before_right_click
  before_right_click=$(TMUX='' command tmux -S "$socket" capture-pane -p)
  click_col=21
  click_row=$top_row
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<2;'"${click_col}"';'"${click_row}"'M'
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<2;'"${click_col}"';'"${click_row}"'m'
  command sleep 0.3
  pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
  [[ $pane == "$before_right_click" ]] ||
    fail "pointer: a right-click on the Fix tab moved the bracket"

  # 2. A click above the band changes nothing (the renderOffset drop).
  # Settle first: the composer's own effects can still be repainting a
  # cell or two right after the mode switch, which would otherwise read as
  # a false click effect.
  command sleep 0.3
  local before_above
  before_above=$(TMUX='' command tmux -S "$socket" capture-pane -p)
  TMUX='' command tmux -S "$socket" send-keys -l -- $'\x1b[<0;5;1M'
  TMUX='' command tmux -S "$socket" send-keys -l -- $'\x1b[<0;5;1m'
  command sleep 0.3
  pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
  [[ $pane == "$before_above" ]] ||
    fail "pointer: a click above the band changed the frame"

  # 2b. The original Luna/High path is asserted against terminal-emulated
  #     screen state so incremental paint deltas cannot hide unchanged cells.
  open_pointer_action "$socket" m
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Models:'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- lun
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Effort:'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- high
  # Enter must land on the filtered row; applying Effort closes the palette.
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'high · Set effort'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    jq -e '.providers.configured.model == "gpt-5.6-luna" and .providers.configured.reasoning == "high"' \
      "$pointer_state/settings.json" >/dev/null 2>&1 && break
    command sleep 0.05
  done
  jq -e '.providers.configured.model == "gpt-5.6-luna" and .providers.configured.reasoning == "high"' \
    "$pointer_state/settings.json" >/dev/null ||
    fail "pointer: the sticky palette persisted the wrong Luna/High destination"
  [[ ! -s $pointer_log ]] || fail "pointer: Luna/High invoked the provider"
  close_pointer_palette "$socket"

  # 2c. A filtered model window is shifted past its first result. Both its
  #     label and final padding cell activate the exact painted destination.
  open_pointer_action "$socket" m
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Models:'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Search Models:'* ]] || fail "pointer: model palette did not open"
  TMUX='' command tmux -S "$socket" send-keys -l -- model-
  repeat 4; do TMUX='' command tmux -S "$socket" send-keys Down; done
  repeat 80; do
    TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
    model_four_row=$(command awk 'index($0, "model-four") { print NR; exit }' "$screen")
    [[ $(<$screen) == *'model-two'* && $(<$screen) != *'model-one'* && $model_four_row -gt 0 ]] && break
    command sleep 0.05
  done
  (( model_four_row > 0 )) || fail "pointer: could not derive the shifted model window"
  click_col=5
  click_row=$model_four_row
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'M'
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'m'
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Applied Configured/mode'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Applied Configured/mode'* ]] ||
    fail "pointer: clicking the shifted row label did not apply model-four"
  jq -e '.providers.configured.model == "model-four" and .providers.configured.reasoning == "high"' \
    "$pointer_state/settings.json" >/dev/null ||
    fail "pointer: the shifted row label persisted the wrong destination"
  [[ ! -s $pointer_log ]] || fail "pointer: clicking a model label invoked the provider"

  close_pointer_palette "$socket"
  open_pointer_action "$socket" m
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Models:'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- model-
  repeat 4; do TMUX='' command tmux -S "$socket" send-keys Down; done
  repeat 80; do
    TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
    model_five_row=$(command awk 'index($0, "model-five") { print NR; exit }' "$screen")
    (( model_five_row > 0 )) && break
    command sleep 0.05
  done
  (( model_five_row > 0 )) || fail "pointer: could not derive model-five's shifted row"
  click_col=78
  click_row=$model_five_row
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'M'
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'m'
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Applied Configured/mode'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Applied Configured/mode'* ]] ||
    fail "pointer: clicking the final padding cell did not apply model-five"
  jq -e '.providers.configured.model == "model-five" and .providers.configured.reasoning == "high"' \
    "$pointer_state/settings.json" >/dev/null ||
    fail "pointer: the final padding cell persisted the wrong destination"
  [[ ! -s $pointer_log ]] || fail "pointer: clicking model-row padding invoked the provider"
  close_pointer_palette "$socket"

  # A terminal-emulated screen, unlike the incremental raw transcript, can
  # prove the guarded row and its route without guessing unchanged cells.
  open_pointer_action "$socket" s
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search All:'* && $pane == *'Set model'* && $pane == *'Set effort'* && $pane == *'Enter open'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Search All:'* && $pane == *'Set model'* && $pane == *'Set effort'* && $pane == *'Enter open'* ]] ||
    fail "pointer: reopening Ctrl-X S did not show the hierarchical settings root"
  TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
  local -i root_query=0 root_model=0 root_effort=0 root_provider=0 root_choices=0 root_more=0 root_status=0
  read -r root_query root_model root_effort root_provider root_choices root_more root_status < <(command awk '
    index($0, "Search All:") { query = NR }
    index($0, "Set model") { model = NR }
    index($0, "Set effort") { effort = NR }
    index($0, "Set provider") { provider = NR }
    index($0, "Initial choices") { choices = NR }
    index($0, "More settings & actions") { more = NR }
    index($0, "Enter open") { status = NR }
    END { print query + 0, model + 0, effort + 0, provider + 0, choices + 0, more + 0, status + 0 }
  ' "$screen")
  (( root_model == root_query + 1 && root_effort == root_model + 1 &&
    root_provider == root_effort + 1 && root_choices == root_provider + 1 &&
    root_more == root_choices + 1 && root_status == root_more + 1 )) ||
    fail "pointer: hierarchical root did not contain its five parent rows"
  TMUX='' command tmux -S "$socket" send-keys -l -- another
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Another suggestion · More settings & actions'* && $pane == *'Enter open'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Another suggestion · More settings & actions'* && $pane == *'Enter open'* ]] ||
    fail "pointer: Another did not expose its guarded action row"
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Actions · S settings'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Actions · S settings'* ]] ||
    fail "pointer: Another did not route to Actions"
  [[ ! -s $pointer_log ]] || fail "pointer: Another's guard invoked the provider"
  TMUX='' command tmux -S "$socket" send-keys Escape
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane != *'Actions ·'* ]] && break
    command sleep 0.05
  done
  [[ $pane != *'Actions ·'* ]] || fail "pointer: Actions did not close"

  # Two candidates promote the footer 3 -> 8, the geometry deal killer 3
  # is about: a click's row must still resolve correctly once the band has
  # moved and grown.
  TMUX='' command tmux -S "$socket" send-keys -l -- 'show current directory'
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'echo suggestion-1'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'echo suggestion-1'* ]] ||
    fail "pointer: the first candidate did not arrive"
  # The insertion action teaches once per workbench session: the session's
  # first-ever candidate must show the full, indivisible `never runs` hint —
  # this is the one point in this gate where exactly one candidate exists.
  [[ $pane == *'never runs'* ]] ||
    fail "pointer: the untaught first candidate did not show the full never-runs hint"
  TMUX='' command tmux -S "$socket" send-keys C-x
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Actions ·'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- a
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'echo suggestion-2'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'echo suggestion-2'* ]] ||
    fail "pointer: the second candidate did not arrive"

  # 3. After promotion, the band top is re-derived from a fresh capture and
  #    a click on a candidate row moves the marker — deal killer 3's proof.
  repeat 80; do
    TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
    read -r candidate_top candidate_1_row < <(command awk '
      index($0, "╭─Ask · [Command] · Fix") { top = NR }
      index($0, "1  echo suggestion-1") { row1 = NR }
      END { print top + 0, row1 + 0 }
    ' "$screen")
    (( candidate_top > 0 && candidate_1_row > 0 )) && break
    command sleep 0.05
  done
  (( candidate_top > 0 && candidate_1_row > 0 )) ||
    fail "pointer: could not derive the promoted band or the candidate row"
  assert_frame_edges "$screen" 80 8

  pre_click_log=$(command wc -l < "$pointer_log")
  # Candidate row text is "  1  echo suggestion-1" (unselected) — the
  # whole row is one clickable target (`candidateRowMarker`'s confidence band
  # lives inside it), so any column within the row moves the selection.
  click_col=9
  click_row=$candidate_1_row
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'M'
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<0;'"${click_col}"';'"${click_row}"'m'
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'› 1  echo suggestion-1'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'› 1  echo suggestion-1'* ]] ||
    fail "pointer: clicking candidate 1's row did not move the selection marker"
  [[ $(command wc -l < "$pointer_log") -eq $pre_click_log ]] ||
    fail "pointer: clicking a candidate row invoked the provider"
  [[ ! -e $pointer_result ]] ||
    fail "pointer: clicking a candidate row wrote an accepted result"
  # Candidate selection keeps the full `never runs` hint for later admissions too.
  contains "$screen" 'Enter insert (never runs)' ||
    fail "pointer: the insertion hint was not visible before accepting"

  # 4. Enter afterwards inserts the CLICKED candidate.
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    [[ -e $pointer_result ]] && break
    command sleep 0.05
  done
  [[ -e $pointer_result ]] || fail "pointer: Enter did not write an accepted result"
  jq -e '.corrected_command == "echo suggestion-1"' "$pointer_result" >/dev/null ||
    fail "pointer: the accepted result was not the clicked candidate"
  command sleep 0.3

  TMUX='' command tmux -S "$socket" send-keys -l -- pointer-input-echo
  TMUX='' command tmux -S "$socket" send-keys Enter
  command sleep 0.2

  TMUX='' command tmux -S "$socket" send-keys C-d
  repeat 80; do
    TMUX='' command tmux -S "$socket" has-session 2>/dev/null || break
    command sleep 0.05
  done
  command sleep 0.2

  # 5. Mouse reporting is enabled only for the workbench's lifetime.
  contains "$transcript" $'\e[?1006h' ||
    fail "pointer: mouse reporting was never enabled"
  contains "$transcript" $'\e[38;2;0;0;0m' ||
    fail "pointer: selected rows did not paint a black foreground"
  contains "$transcript" $'\e[48;2;255;255;255m' ||
    fail "pointer: selected rows did not paint a white background"
  ! contains "$transcript" $'\e[7m' ||
    fail "pointer: selected rows still relied on terminal reverse video"
  for sequence in $'\e[?1000l' $'\e[?1002l' $'\e[?1003l' $'\e[?1006l'; do
    contains "$transcript" "$sequence" ||
      fail "pointer: mouse mode $sequence was not disabled at teardown"
  done

  # 6. The existing structural assertions still pass unchanged.
  assert_restored "$transcript" pointer-input-echo
  assert_main_screen "$transcript"
  assert_peak_height "$transcript" 8

  TMUX='' command tmux -S "$socket" kill-server 2>/dev/null
  PTY_TMUX_SOCKET=''
}

run_pointer_gate_case

run_ascii_palette_gate_case() {
  local socket=$TEST_DIR/tmux-ascii-palette.sock
  local transcript=$TEST_DIR/ascii-palette.typescript
  local session_file=$TEST_DIR/ascii-palette-session.json
  local result_file=$TEST_DIR/ascii-palette-result.json
  local provider_log=$TEST_DIR/ascii-palette-provider.jsonl
  local state_dir=$TEST_DIR/ascii-palette-state
  local screen=$TEST_DIR/ascii-palette-screen.txt
  local body=$TEST_DIR/ascii-palette-body.txt
  local pane=''
  local -i query_row=0

  make_session "$session_file" fast generate
  PTY_TMUX_SOCKET=$socket
  TMUX='' command tmux -f /dev/null -S "$socket" new-session -d -x 80 -y 40 \
    "NO_UNICODE=1 SHELLQ_STATE_DIR=${(q)state_dir} SHELLQ_PTY_CASE=ascii-palette SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)session_file} SHELLQ_PTY_RESULT=${(q)result_file} SHELLQ_PTY_PROVIDER_LOG=${(q)provider_log} ${(q)PTY_SCRIPT} ${(q)transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" ||
    fail "ascii palette: could not start the isolated PTY"

  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Ask | [Command] | Fix'* ]] && break
    command sleep 0.05
  done
  open_pointer_action "$socket" m
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Models:'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- lun
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Effort:'* ]] && break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" send-keys -l -- high
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'Search Effort: high'* && $pane == *'Enter apply / Esc clear'* ]] && break
    command sleep 0.05
  done
  [[ $pane == *'Search Effort: high'* && $pane == *'Enter apply / Esc clear'* ]] ||
    fail "ascii palette: contextual footer did not use the ASCII separator"
  TMUX='' command tmux -S "$socket" capture-pane -p > "$screen"
  query_row=$(command awk 'index($0, "Search Effort:") { print NR; exit }' "$screen")
  (( query_row > 0 )) || fail "ascii palette: could not locate the settled palette body"
  command sed -n "${query_row},$(( query_row + 5 ))p" "$screen" > "$body"
  ! LC_ALL=C command grep -q '[^ -~]' "$body" ||
    fail "ascii palette: Unicode leaked into the settled palette body rows"
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane != *'Search Effort:'* && $pane == *'Luna | high'* ]] && break
    command sleep 0.05
  done
  [[ $pane != *'Search Effort:'* && $pane == *'Luna | high'* ]] ||
    fail "ascii palette: effort completion did not restore the Workbench"
  jq -e '.providers.configured.model == "gpt-5.6-luna" and .providers.configured.reasoning == "high"' \
    "$state_dir/settings.json" >/dev/null ||
    fail "ascii palette: persisted the wrong Luna/High destination"
  [[ ! -s $provider_log ]] || fail "ascii palette: changing settings invoked the provider"
  TMUX='' command tmux -S "$socket" send-keys C-d
  repeat 80; do
    TMUX='' command tmux -S "$socket" has-session 2>/dev/null || break
    command sleep 0.05
  done
  TMUX='' command tmux -S "$socket" kill-server 2>/dev/null
  PTY_TMUX_SOCKET=''
}

run_ascii_palette_gate_case

# Verification, not code: stock ScrollBoxRenderable already implements
# onMouseEvent scroll handling, so no onMouseScroll router is written unless
# one of these checks finds a defect (double-scroll, or scroll leaking into
# the composer row).
run_wheel_gate_case() {
  local socket=$TEST_DIR/tmux-wheel.sock
  local transcript=$TEST_DIR/wheel.typescript
  local wheel_session=$TEST_DIR/wheel-session.json
  local wheel_result=$TEST_DIR/wheel-result.json
  local wheel_log=$TEST_DIR/wheel-provider.jsonl
  local pane=''
  local -i top_row=0

  make_session "$wheel_session" fast generate

  PTY_TMUX_SOCKET=$socket
  TMUX='' command tmux -f /dev/null -S "$socket" new-session -d -x 80 -y 40 \
    "SHELLQ_PTY_CASE=wheel SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)wheel_session} SHELLQ_PTY_RESULT=${(q)wheel_result} SHELLQ_PTY_PROVIDER_LOG=${(q)wheel_log} ${(q)PTY_SCRIPT} ${(q)transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" ||
    fail "wheel: could not start the isolated 80x40 wheel PTY"

  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'╭─Ask · [Command] · Fix'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'╭─Ask · [Command] · Fix'* ]] ||
    fail "wheel: workbench did not render at 80x40"

  # A wheel over the composer row changes nothing.
  top_row=$(TMUX='' command tmux -S "$socket" capture-pane -p |
    command awk 'index($0, "╭─Ask · [Command] · Fix") { print NR }')
  (( top_row > 0 )) || fail "wheel: could not derive the compact band's top row"
  # A flat sleep before this capture can race the renderer's own initial
  # settle under load, catching a transient partial repaint of the seeded
  # composer draft as if it were the steady state; wait for the known-correct
  # draft text before trusting a capture as the "before" baseline.
  local before_composer
  repeat 80; do
    before_composer=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $before_composer == *'show current directory'* ]] && break
    command sleep 0.1
  done
  [[ $before_composer == *'show current directory'* ]] ||
    fail "wheel: the composer draft never settled before the wheel probe"
  TMUX='' command tmux -S "$socket" send-keys -l -- \
    $'\x1b[<65;10;'"$(( top_row + 1 ))"'M'
  command sleep 0.3
  pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
  [[ $pane == "$before_composer" ]] ||
    fail "wheel: a wheel over the composer row changed the frame"

  # Get a candidate with a long TLDR, then wheel over its description.
  # The composer template's own default is already "show current
  # directory" — Enter submits it as-is.
  TMUX='' command tmux -S "$socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *'1  echo suggestion-1'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'1  echo suggestion-1'* ]] ||
    fail "wheel: the candidate did not arrive"
  command sleep 0.2

  top_row=$(TMUX='' command tmux -S "$socket" capture-pane -p |
    command awk 'index($0, "╭─Ask · [Command] · Fix") { print NR }')
  (( top_row > 0 )) || fail "wheel: could not derive the promoted band's top row"
  repeat 20; do
    TMUX='' command tmux -S "$socket" send-keys -l -- \
      $'\x1b[<65;10;'"$(( top_row + 1 ))"'M'
    pane=$(TMUX='' command tmux -S "$socket" capture-pane -p)
    [[ $pane == *SCROLL_DESCRIPTION_BOTTOM* ]] && break
    command sleep 0.1
  done
  [[ $pane == *SCROLL_DESCRIPTION_BOTTOM* ]] ||
    fail "wheel: wheeling over the candidate description did not reach its bottom"
  [[ $pane == *'› 1  echo suggestion-1'* ]] ||
    fail "wheel: scrolling the description changed the selected candidate"

  TMUX='' command tmux -S "$socket" send-keys Escape
  TMUX='' command tmux -S "$socket" send-keys Escape
  command sleep 0.3
  TMUX='' command tmux -S "$socket" kill-server 2>/dev/null
  PTY_TMUX_SOCKET=''

  # A separate session: wheel over a long Ask answer.
  local ask_wheel_session=$TEST_DIR/wheel-ask-session.json
  local ask_wheel_result=$TEST_DIR/wheel-ask-result.json
  local ask_wheel_log=$TEST_DIR/wheel-ask-provider.jsonl
  local ask_transcript=$TEST_DIR/wheel-ask.typescript
  local ask_socket=$TEST_DIR/tmux-wheel-ask.sock
  make_session "$ask_wheel_session" long-answer ask

  PTY_TMUX_SOCKET=$ask_socket
  TMUX='' command tmux -f /dev/null -S "$ask_socket" new-session -d -x 80 -y 40 \
    "SHELLQ_PTY_CASE=wheel-ask SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)ask_wheel_session} SHELLQ_PTY_RESULT=${(q)ask_wheel_result} SHELLQ_PTY_PROVIDER_LOG=${(q)ask_wheel_log} ${(q)PTY_SCRIPT} ${(q)ask_transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" ||
    fail "wheel: could not start the isolated Ask wheel PTY"
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$ask_socket" capture-pane -p)
    [[ $pane == *'Ask about this repo'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'Ask about this repo'* ]] ||
    fail "wheel: the Ask workbench did not render"
  TMUX='' command tmux -S "$ask_socket" send-keys -l -- 'what is this'
  TMUX='' command tmux -S "$ask_socket" send-keys Enter
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$ask_socket" capture-pane -p)
    [[ $pane == *'line 01 repository summary'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'line 01 repository summary'* ]] ||
    fail "wheel: the long Ask answer did not arrive"
  command sleep 0.2

  top_row=$(TMUX='' command tmux -S "$ask_socket" capture-pane -p |
    command awk 'index($0, "╭─[Ask] · Command · Fix") { print NR }')
  (( top_row > 0 )) || fail "wheel: could not derive the Ask band's top row"
  repeat 20; do
    TMUX='' command tmux -S "$ask_socket" send-keys -l -- \
      $'\x1b[<65;10;'"$(( top_row + 1 ))"'M'
    pane=$(TMUX='' command tmux -S "$ask_socket" capture-pane -p)
    [[ $pane == *ASK_SCROLL_BOTTOM* ]] && break
    command sleep 0.1
  done
  [[ $pane == *ASK_SCROLL_BOTTOM* ]] ||
    fail "wheel: wheeling over the Ask answer did not reach its bottom"

  TMUX='' command tmux -S "$ask_socket" send-keys Escape
  command sleep 0.3
  TMUX='' command tmux -S "$ask_socket" kill-server 2>/dev/null
  PTY_TMUX_SOCKET=''

  # A separate session: wheel over a composer draft that overflows the
  # composer's row cap. Stock textareas consume wheel input (no
  # `defaultPrevented` guard on the mouse-dispatch path), so the scoped-wheel
  # contract permits this as viewport panning of the focused textarea, never
  # a mutation. This proves the bound: the pan moves the viewport but leaves
  # the draft text and the provider log untouched.
  local ml_session=$TEST_DIR/wheel-ml-session.json
  local ml_result=$TEST_DIR/wheel-ml-result.json
  local ml_log=$TEST_DIR/wheel-ml-provider.jsonl
  local ml_transcript=$TEST_DIR/wheel-ml.typescript
  local ml_socket=$TEST_DIR/tmux-wheel-ml.sock
  local ml_draft=$'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\nindia\njuliet'
  local -i log_before_wheel=0 log_after_wheel=0
  make_session "$ml_session" fast ask

  PTY_TMUX_SOCKET=$ml_socket
  TMUX='' command tmux -f /dev/null -S "$ml_socket" new-session -d -x 80 -y 40 \
    "SHELLQ_PTY_CASE=wheel-ml SHELLQ_PTY_WORKBENCH=${(q)WORKBENCH} SHELLQ_PTY_WORKDIR=${(q)TEST_DIR} SHELLQ_PTY_SESSION=${(q)ml_session} SHELLQ_PTY_RESULT=${(q)ml_result} SHELLQ_PTY_PROVIDER_LOG=${(q)ml_log} ${(q)PTY_SCRIPT} ${(q)ml_transcript} ${(q)ZSH_BIN} ${(q)SCRIPT_PATH} child" ||
    fail "wheel: could not start the isolated multiline-composer wheel PTY"
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p)
    [[ $pane == *'╭─[Ask] · Command · Fix'* ]] && break
    command sleep 0.1
  done
  [[ $pane == *'╭─[Ask] · Command · Fix'* ]] ||
    fail "wheel: multiline-composer workbench did not render"

  TMUX='' command tmux -S "$ml_socket" send-keys -l -- \
    $'\e[200~'"$ml_draft"$'\e[201~'
  repeat 80; do
    pane=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p)
    [[ $pane == *juliet* ]] && break
    command sleep 0.1
  done
  [[ $pane == *juliet* ]] ||
    fail "wheel: the multiline composer paste did not land"
  [[ $pane != *alpha* ]] ||
    fail "wheel: the composer viewport unexpectedly already showed the top line"
  command sleep 0.2

  top_row=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p |
    command awk 'index($0, "╭─[Ask] · Command · Fix") { print NR }')
  (( top_row > 0 )) || fail "wheel: could not derive the multiline composer's top row"

  # A wheel report above the band — in the terminal's own scrollback, not
  # the footer's rows — is measured, not assumed: split-footer geometry
  # gates mouse events by row before hitTest/fallback ever run.
  local -i above_row=$(( top_row > 3 ? top_row - 3 : 1 ))
  local before_above_pane after_above_pane
  before_above_pane=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p)
  TMUX='' command tmux -S "$ml_socket" send-keys -l -- \
    $'\x1b[<65;10;'"$above_row"'M'
  command sleep 0.3
  after_above_pane=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p)
  [[ $after_above_pane == "$before_above_pane" ]] ||
    fail "wheel: a wheel report above the footer band changed the frame"

  [[ -f $ml_log ]] && log_before_wheel=$(command wc -l < "$ml_log")
  (( log_before_wheel == 0 )) ||
    fail "wheel: pasting a multiline composer draft invoked the provider"

  repeat 20; do
    TMUX='' command tmux -S "$ml_socket" send-keys -l -- \
      $'\x1b[<64;10;'"$(( top_row + 3 ))"'M'
    pane=$(TMUX='' command tmux -S "$ml_socket" capture-pane -p)
    [[ $pane == *alpha* ]] && break
    command sleep 0.1
  done
  [[ $pane == *alpha* ]] ||
    fail "wheel: wheeling up over the composer did not pan its viewport to the top line"

  [[ -f $ml_log ]] && log_after_wheel=$(command wc -l < "$ml_log")
  (( log_after_wheel == log_before_wheel )) ||
    fail "wheel: scrolling the composer viewport invoked the provider"

  TMUX='' command tmux -S "$ml_socket" send-keys Enter
  repeat 80; do
    [[ -f $ml_log ]] && break
    command sleep 0.1
  done
  [[ -f $ml_log ]] || fail "wheel: the multiline composer draft never submitted"
  jq -e --arg draft "$ml_draft" '.input.query == $draft' "$ml_log" >/dev/null ||
    fail "wheel: panning the composer viewport changed the submitted draft text"

  TMUX='' command tmux -S "$ml_socket" send-keys Escape
  command sleep 0.3
  TMUX='' command tmux -S "$ml_socket" kill-server 2>/dev/null
  # tmux can return before the pane's `/usr/bin/script` wrapper finishes its
  # footer receipt; let that existing child drain before the EXIT trap removes
  # the private directory.
  command sleep 0.5
  PTY_TMUX_SOCKET=''
}

run_wheel_gate_case

print -r -- "PASS PTY smoke: single-owner native frame with per-row edge widths, always-visible mode tabs with bracketed selection, no routine submit label, framed details inspector without duplicated key help, monotonic 3/8/12 promotion, action sheet, vertical candidate navigation and review-only insertion, peak receipts, never-auto-execute, context privacy, failure/cancellation, 80/100/140 columns, restoration, top/bottom ZLE teardown geometry, pointer mode-tab and candidate-row clicks with byte-level mouse-mode teardown, wheel scrolling scoped to the reader under the pointer, wheel over an overflowing composer draft pans its viewport without mutating the draft or invoking the provider"
