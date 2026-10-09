## MODIFIED Requirements

### Requirement: Compact interactive command workbench
On explicit Ctrl-O invocation, the plugin SHALL acquire a bounded safe prompt
anchor and open an interactive workbench on the current terminal screen, SHALL
keep preceding terminal content visible, and SHALL NOT enter the alternate
screen. If a TTY does not return a valid prompt anchor, the plugin SHALL fail
locally before starting the renderer. Before an invocation has promoted,
compose, Command or Fix provider loading before a candidate, inline validation,
cancellation, and simple provider errors SHALL render as one bordered frame of
exactly three rows at 80, 100, and 140 columns while the composer occupies one
visual line.
When the composer wraps to more visual lines, the frame MAY grow by exactly one
row per additional visual line, up to the eight-row envelope, and SHALL NOT
shrink again during that invocation. Command or Fix candidates SHALL promote the footer to at least eight rows and
grow through twelve up to the configured maximum as needed for the assessment, explanation, choice
separator, and selected command. Ctrl-X actions, editors, Provider Setup, and the
typed palette SHALL promote the footer to eight rows; Ctrl-X details and Doctor
SHALL promote it to the smallest fitting of twelve rows and the configured maximum. Ask loading, previews, and answers SHALL select the smallest fitting frame of
four, eight, twelve, or the configured maximum rows from rendered wrapped content. Footer height SHALL remain
capped at the configured maximum (twelve when unset) and monotonic during an
invocation: after promotion, every state SHALL remain within the promoted
footprint, it SHALL NOT shrink before close, and the next invocation SHALL
start at three rows. The workbench SHALL display all three Ask, Command, and Fix
modes textually with the selected one identified without relying on color and
SHALL use a focused full-width word-wrapping composer. Opening a reuse-enabled
bundled App Server workbench MAY initialize its private process and prepare its
Ask thread; opening or switching modes SHALL start no inference turn and SHALL
emit no provider-derived preview, result, candidate, or pointer authority.

The typed palette SHALL use the promoted eight-row envelope with exactly six
interior rows and SHALL not shrink it before close. Query input SHALL not become
composer content.

#### Scenario: No available request
- **WHEN** the user presses Ctrl-O with an empty edit buffer and no actionable
  failed command
- **THEN** the three-row frame opens with Ask selected, a blank focused
  composer, and no inference turn

#### Scenario: Prompt anchor is unavailable
- **WHEN** the terminal does not return a valid bounded cursor coordinate
- **THEN** the plugin preserves the shell buffer, reports the local failure,
  and does not start the workbench renderer

#### Scenario: Workbench uses the current edit buffer
- **WHEN** the user presses Ctrl-O with a non-empty raw edit buffer
- **THEN** the frame opens with Command selected and that buffer prefilled in
  the composer, and starts no inference turn

#### Scenario: Workbench uses the last actionable failure
- **WHEN** the user presses Ctrl-O with an empty edit buffer after an actionable
  failed command
- **THEN** the frame opens with Fix selected, the recorded failed command and
  its available bounded sanitized captured output selected, and starts no
  inference turn

#### Scenario: User changes mode
- **WHEN** the composer is active and the user presses Tab or Shift-Tab
- **THEN** selection cycles among Ask, Command, and Fix without starting a
  process, thread, or turn, and all three modes remain visible

#### Scenario: User submits the composer
- **WHEN** the user presses Enter with a valid query in the composer
- **THEN** exactly one inference turn starts using the displayed mode, model,
  effort, context-inclusion, and Ask-session state, and no newline is inserted
  into the composer

#### Scenario: User opens local diagnostics
- **WHEN** the user invokes Ctrl-X D or clicks the visible Doctor action from
  an eligible idle primary composer
- **THEN** Doctor opens locally without starting a provider process, thread, or
  turn

#### Scenario: User composes multiple lines
- **WHEN** the user presses Shift-Enter or pastes text containing line breaks
- **THEN** those line breaks remain in the composer, no inference turn starts,
  and a later unmodified Enter submits the preserved multi-line query

#### Scenario: User edits a prompt before submitting
- **WHEN** the user presses Ctrl-X E before a request has produced a candidate
- **THEN** the current Ask, Command, or Fix draft opens in the promoted editor,
  Enter inserts a newline without submitting, Ctrl-X W saves the draft back to
  the composer, and Esc discards the edit

#### Scenario: Resting states stay three rows
- **WHEN** the workbench has not promoted, its composer occupies one visual
  line, and it is composing, waiting for a Command or Fix provider before a
  candidate, or showing inline validation, cancellation, or a simple provider
  error at 80, 100, or 140 columns
- **THEN** it occupies exactly three rows without horizontal overflow and keeps
  its mode strip, composer, and status rail legible

#### Scenario: Long input wraps and grows the frame
- **WHEN** the user types more text than fits one composer line
- **THEN** the text wraps within the composer width, the frame grows by one row
  per additional visual line without exceeding the eight-row composer envelope, and it
  does not shrink again during that invocation

#### Scenario: Review content promotes the invocation
- **WHEN** Ask loading, an Ask preview, Ask answer, Command or Fix candidate,
  Ctrl-X action, editor, Provider Setup, or the typed palette becomes visible
- **THEN** the footer grows to at least eight rows — growing further, up to
  the configured maximum, as the content needs — and does not shrink again
  before the workbench closes

#### Scenario: First Ask preview promotes the invocation
- **WHEN** a loading Ask receives its first valid preview
- **THEN** the preview displays inside the content-driven footprint, capped at the configured maximum,
  which does not shrink if the request later succeeds, fails, or is cancelled

#### Scenario: Details promote the invocation
- **WHEN** Ctrl-X details becomes visible
- **THEN** the footer grows to the smallest fitting of twelve rows and the configured
  maximum and does not shrink again before the workbench closes

#### Scenario: Doctor promotes the invocation
- **WHEN** Doctor becomes visible
- **THEN** the footer grows to the smallest fitting of twelve rows and the configured
  maximum and does not shrink again before the workbench closes

#### Scenario: Promoted states keep their footprint
- **WHEN** the workbench has promoted and later composes, waits for a provider,
  shows validation or an error, or leaves a promoted surface
- **THEN** it returns the interaction within the retained promoted footprint
  without moving the footer or emitting blank rows beneath it

#### Scenario: A promoted surface closes
- **WHEN** the user leaves a review, editor, details, Doctor, Provider Setup, typed palette, or help
  surface without closing the workbench
- **THEN** the primary interaction returns within the already promoted footer
  footprint without moving the footer or emitting blank rows below it

#### Scenario: A new invocation starts compact
- **WHEN** a previously promoted or wrapped workbench has closed and the user
  presses Ctrl-O again
- **THEN** the new workbench starts as an exact three-row frame

#### Scenario: Palette uses the promoted envelope
- **WHEN** the user opens the typed palette from an idle Workbench
- **THEN** the promoted envelope remains open with exactly six interior palette
  rows, no provider request starts, and draft, cursor, context, result,
  conversation, pointer, shell-buffer, and composer state remain unchanged


### Requirement: Scan-first workbench presentation
The workbench SHALL render as exactly one bordered frame whose top border,
bottom border, and both side borders are drawn by a single owning component, so
that every interior row carries a left and a right edge, every edge shares one
color and one glyph set, and the frame spans the full terminal width with its
bottom-right corner on the last terminal cell. The top border SHALL carry the
mode strip on its left, naming all three modes and identifying the selected
one without color, and, right-aligned flush against the top-right corner, the
session's provider followed by its model with the effort level appended
when space allows. The bottom border SHALL carry, on its left, cwd, response
activity/timing, or an actionable transient message that takes precedence (see Optional recent command context), and
on its right, a shown action when present followed by disclosure when relevant
followed by the Ctrl-X affordance, flush against the bottom-right corner —
disclosure keeps the same position immediately left of the Ctrl-X affordance
whether or not a shown action precedes it. Both borders SHALL fill the gap
between their left and right content with the border's own horizontal glyph;
space SHALL NOT be used as border fill. A candidate's rank SHALL appear on its own command row; selected confidence
and risk SHALL appear in the assessment row and Details, never on either
border. Under
narrowing width the top border SHALL degrade through a fixed ladder — drop
effort from the model range, then drop the provider, then drop the model
range entirely, then let the mode strip's own truncation take over — always
naming all three modes when space allows; the provider drops before the model
because the model names remain provider-distinctive and the exact provider
stays available in Ctrl-X details. The bottom border SHALL degrade through a
fixed four-rung ladder, each rung firing only if the border is still over
budget after the previous one: shorten the Ctrl-X affordance from
`^X actions` to `^X`, then truncate the left slot (cwd to its last path
segment, or a message to a fixed cell cap), then drop disclosure entirely,
then drop the Ctrl-X affordance entirely — the last rung firing only when a
shown action needs the room it frees, so `^X` is never dropped merely because
nothing else is competing for its cells. After each border's forward ladder
completes, that border SHALL walk its own fired rungs from most- to
least-recently-fired and restore a single rung's field to its value
immediately before that rung fired whenever the restored state still fits the
budget, stopping that field's own restoration at the first value that does not
fit, without ever reordering that border's declared drop sequence. A transient
message SHALL be truncated to a fixed cell cap with a visible ellipsis when
clipped.
The composer SHALL contain only a prompt marker and placeholder or
user-authored text and SHALL span the full interior width; no routine submit
label SHALL occupy it. A contextual action SHALL be shown only when it is not
self-evident or when it is safety-critical. An insertion action SHALL show
`never runs` in full and indivisible for the first candidate a workbench
session ever shows; every later candidate in that same session SHALL instead
show a short indivisible insertion hint, gated by exactly one session-scoped
flag that, once set, never resets before the workbench closes. Ask answers,
candidates, editors, actions, Settings, and details SHALL be rendered inside
the same frame and SHALL NOT be printed automatically into ordinary terminal
scrollback. When the Ctrl-X actions surface is open, it SHALL render as a
two-column grid inside the eight-row envelope: a header row; a horizontal
rule computed to the actual rendered width, with a vertical divider
separating the two columns; and one row per action pair, with each non-sending
half independently clickable to the letter it names, using hit ranges from the
same function that paints the row's text. The rule and divider SHALL scale to
the rendered width rather than a literal cell count; the ASCII fallback SHALL
replace only the rule and divider, using `-`/`+` and `|`. The provider action
SHALL be named on the actions surface's header row rather than occupying a grid
cell, so the grid keeps its existing row count inside the envelope while the
keymap stays complete on the one surface that carries it. Operational meaning
SHALL NOT rely on color or Unicode, exact secondary information SHALL remain
available through Ctrl-X details, and optional pointer input SHALL NOT change
the meaning of any rendered state. The frame outline color SHALL maintain a
contrast ratio of at least 3:1 against `#000000` and `#1E1E1E`.

#### Scenario: One component owns every edge
- **WHEN** the workbench renders at 80, 100, or 140 columns in any resting or
  promoted state
- **THEN** every rendered row begins and ends with the frame's edge glyphs, each
  row occupies exactly the terminal width in cells, and the bottom-right corner
  is the last cell of the bottom row

#### Scenario: All modes stay visible
- **WHEN** the workbench renders in any mode
- **THEN** the top border shows Ask, Command, and Fix together with the selected
  one bracketed, and the selection remains identifiable with color disabled

#### Scenario: Rail follows a declared slot grammar
- **WHEN** either border renders at any supported width in any state
- **THEN** the top border shows the mode strip on the left and the provider,
  model, and effort (each while space allows) right-aligned in that order,
  the bottom border shows cwd, response timing, or a transient message on the left, and on the
  right a shown action when present followed by disclosure when relevant
  followed by the Ctrl-X affordance, and each border fills its own gap with its
  own glyph, never a space

#### Scenario: Top border follows a declared slot grammar
- **WHEN** the top border renders at any supported width in any state
- **THEN** the mode strip appears on the left, the provider and model appear
  right-aligned with the effort level appended when space allows, and the gap
  between them is filled with the border's own glyph, never a space

#### Scenario: Bottom border follows a declared slot grammar
- **WHEN** the bottom border renders at any supported width in any state
- **THEN** cwd, response timing, or a transient message appears on the left; a shown action when
  present, disclosure when relevant, and the Ctrl-X affordance appear
  right-aligned in that order; and the gap between the two groups is filled
  with the border's own glyph, never a space

#### Scenario: A configured provider is labelled without exposing its path
- **WHEN** the active provider is a configured argv matching no registered
  identifier
- **THEN** the top border shows a fixed literal in the provider slot rather than
  any part of the command's path, and the exact command appears only in Ctrl-X
  details

#### Scenario: Provider drops before the model under narrowing width
- **WHEN** the top border is over budget after effort has already been
  dropped
- **THEN** the provider is dropped before the model range, and the exact
  provider remains available through Ctrl-X details

#### Scenario: Candidate position note requires a second candidate
- **WHEN** two or more validated candidates are retained
- **THEN** each candidate's rank appears on its own row, and selected confidence
  and risk appear in the assessment row and Details, never on either border

#### Scenario: Ladder over-drop is reclaimed
- **WHEN** a border's forward ladder has dropped a rung whose field, restored
  alone, would still fit that border's current budget
- **THEN** that border restores the field after its forward pass completes,
  without reordering its declared drop sequence, and stops restoring that
  field at the first value that does not fit

#### Scenario: Note slot does not outlive a resolved Ctrl-X chord
- **WHEN** a Ctrl-X chord opens the actions surface or resolves to an action
- **THEN** the bottom border's left slot shows cwd rather than a stale
  message, since opening or resolving the chord is itself a state change

#### Scenario: Actions sheet renders a two-column clickable grid
- **WHEN** the user opens the actions surface at a supported width
- **THEN** a header row, a rule and divider computed to the rendered width,
  and one row per action pair render inside the eight-row envelope, each row
  split into halves; only non-sending halves are independently clickable and
  each matches the letter it displays

#### Scenario: Actions sheet click matches its own letter
- **WHEN** the user clicks either half of an actions-sheet row
- **THEN** exactly the action that half's letter would perform occurs, using
  hit ranges computed by the same function that painted the row's text

#### Scenario: Composer shows no routine submit label
- **WHEN** the composer is focused and no contextual or safety-critical action
  applies
- **THEN** the composer row contains only the prompt marker and the placeholder
  or user-authored text, spans the full interior width, and shows no submit
  label or submit glyph

#### Scenario: One primary action is obvious
- **WHEN** a request is in flight, a request failed or was cancelled, a promoted
  surface is open, an edit is unsaved, or a candidate can be inserted
- **THEN** exactly one applicable action of `Esc cancel`, `Enter retry`,
  `Esc back`, `Ctrl-X W save`, or an insertion action is visually
  prioritized, and any Command or Fix insertion action includes `never runs`
  in full whenever width permits, including later admissions

#### Scenario: Compact supported widths
- **WHEN** the workbench renders at 80, 100, or 140 columns
- **THEN** unpromoted one-line states remain exactly three rows, promoted states
  remain within the configured maximum, no row overflows horizontally, contextual segments
  drop first, and mode, current task or selected result, cwd, model, and Ctrl-X
  remain legible

#### Scenario: Rail uses compatible decoration
- **WHEN** Unicode and color are available
- **THEN** safe non-private-use border characters and one focus accent MAY
  reinforce the frame hierarchy without replacing textual meaning

#### Scenario: Rail falls back accessibly
- **WHEN** Unicode or color is unavailable or disabled
- **THEN** the same single component draws an ASCII frame and readable text
  preserves the mode, disclosure, state, and action meaning without requiring
  private-use font glyphs

#### Scenario: State remains understandable without color
- **WHEN** the workbench is composing, loading, successful, failed, cancelled,
  showing saved or new chat, or showing included or held captured output
- **THEN** readable text identifies the mode, disclosure, operational state, and
  any shown action without relying on color

#### Scenario: Reduced motion is respected
- **WHEN** a provider request is in flight and reduced motion is requested
- **THEN** the loading state is conveyed without animation while remaining
  textually identifiable

#### Scenario: Frame outline meets measured contrast
- **WHEN** the frame renders with color available
- **THEN** the outline color `#6B7280` is used, and it measures at least 3:1
  against `#000000` and `#1E1E1E`

#### Scenario: Ask answer stays in the workbench
- **WHEN** a validated Ask answer is displayed
- **THEN** it appears inside the frame in a bounded scrollable reader sized to content within the
  configured maximum of total frame rows above an immediately focused follow-up composer, and is not automatically
  written into ordinary terminal scrollback

#### Scenario: User scrolls a long Ask answer
- **WHEN** a validated Ask answer exceeds the visible reader rows and the user
  scrolls it
- **THEN** the answer viewport moves within the bounded answer without changing
  the query, invoking the provider, writing a result, or exceeding the configured maximum of footer
  rows

#### Scenario: User edits the previous Ask question
- **WHEN** an Ask answer is visible and the user presses Ctrl-X E
- **THEN** the previous question opens in the promoted prompt editor, Enter
  inserts a newline without submitting, and Ctrl-X W saves it back to the
  focused composer without shrinking the retained promoted frame

#### Scenario: User opens details
- **WHEN** the user presses Ctrl-X H in the primary view
- **THEN** the workbench exposes, inside the frame, exact cwd, repository
  access, last-command and pipeline metadata, context provenance and bytes,
  inclusion state, saved-chat state, full provider, model and effort
  selection, and exact candidate confidence and risk when available, without
  starting a provider call or changing request state

#### Scenario: Details do not duplicate the rail or key help
- **WHEN** the details view is open
- **THEN** it shows only fields that neither border already shows, and the
  full keymap remains available on the actions surface rather than inside the
  inspector

#### Scenario: User leaves details
- **WHEN** the details view is open and the user presses Ctrl-X H or Escape
- **THEN** the primary workbench interaction returns inside the retained
  promoted frame — the smallest fitting of twelve rows and the configured
  maximum — without closing the workbench, shrinking it, or changing its
  request state

#### Scenario: Ask preview stays in the workbench
- **WHEN** a valid display-only Ask preview is available while the request is
  active
- **THEN** it appears inside the frame in a bounded scrollable reader in the content-driven
  frame, up to the configured maximum, is identified as streaming without color, exposes only `Esc
  cancel` as the primary action, and is not printed to ordinary scrollback


### Requirement: Invocation-local Ask conversation view
The workbench SHALL retain, for the current workbench opening only, a bounded
display list of validated Ask turns. Each turn SHALL contain the exact submitted
question and the accepted validated answer, SHALL be appended exactly once only
after existing final-answer validation and any required session-pointer commit
succeed, and SHALL NOT be appended from preview, commentary, failure,
cancellation, stale output, malformed output, or an uncommitted pointer.

The list SHALL retain at most 50 whole turns, for at most 614400 UTF-8 payload
bytes under the existing per-question and per-answer limits. Appending beyond
that bound SHALL drop the oldest whole turn. The list SHALL remain in process
memory only and SHALL NOT be written to disk, terminal scrollback, the shell
edit buffer, or a result file; replayed to a provider; or included in a later
provider request. Provider continuation SHALL continue to use only the existing
session-pointer contract.

At rest, validated turns SHALL appear in chronological order inside the existing
bounded Ask reader, newest beside the composer. Each whitespace-folded question
SHALL have a `You:` label, bold text and neutral shading above its answer, with
one blank row between turns. Styling SHALL follow the row's role, not prefixes
inside answer prose. Mounting or remounting SHALL expose the newest answer's
tail. The oldest end SHALL state `Earlier exchanges cleared` only after retention
drops a turn. The focused empty composer SHALL say `Ask a follow-up…`, or
`Ask a local question…` for the independent local provider.

While an Ask request is loading or streaming, one row above the existing status
or bounded scrollable preview SHALL identify the submitted question with the
same `You:` treatment and a cell-truncated summary with a visible ellipsis when
clipped. It SHALL remain display-only. Earlier validated turns MAY be hidden
in flight and SHALL return unchanged after failure or cancellation.

Up and Down SHALL scroll the conversation while the Ask composer is empty and
retain native composer behavior while it is non-empty. PageUp and PageDown
SHALL scroll by viewport regardless of draft content. Wheel scrolling over the
conversation SHALL scroll only that reader. Older turns SHALL be reached by
scrolling up. Labels SHALL preserve meaning without color or italic support.

Local thinking SHALL appear in italic light grey. Clicking its content header
SHALL toggle visibility without changing inference, submitting or cancelling.
Visibility SHALL start enabled per opening; hiding SHALL reset preview scrolling
to its tail without shrinking the retained frame height.

Ctrl-T and the footer thinking control SHALL instead toggle generation on/off
for the next request. A running request SHALL continue unchanged, its visible
thinking SHALL not be hidden by this shortcut, and the footer SHALL identify
that the preference applies next. The preference SHALL be saved atomically per
validated endpoint and exact model, preserving other settings under the existing
4096-byte limit. A failed write SHALL leave the current preference unchanged and
show a fixed failure message. No override SHALL mean endpoint default; choosing
`endpoint default` in local effort Settings SHALL remove only that override.
The main rail SHALL omit `endpoint default` and its separator and hit target.

An explicit preference SHALL reach only the local adapter through its fresh
allowlisted environment as `SHELLQ_LOCAL_OPENAI_THINKING=on|off`. Other values
SHALL fail before network access. After model discovery, an explicit choice
SHALL use a bounded, verified GET `/props` to check that the loaded template
advertises `enable_thinking` outside Jinja comments. This capability check SHALL
not be presented as universal proof that a server honors the override. Unsupported properties SHALL fail closed before POST
with a fixed thinking-control error and endpoint-default recovery. A supported
choice SHALL add `chat_template_kwargs.enable_thinking` as a boolean to local
Ask, Command and Fix requests. With no override, neither the properties request
nor the additional completion field SHALL be sent. This control SHALL not change
strict final validation, completion limits, cancellation, or provider isolation.

Starting a new Ask chat, changing Ask engines, or leaving Ask mode SHALL clear
the visible turn list and prior-question edit state without mutating a committed
provider pointer. An armed new-chat intent SHALL survive a mode round-trip and
SHALL be disclosed again when Ask returns; only submission through the existing
new-chat acceptance contract consumes it. A failed or cancelled first turn of
an armed new chat SHALL keep the visible list empty and the previous pointer
resumable. Reopening the workbench SHALL start with an empty visible list even
when a provider conversation is resumable. Returning from Settings, details,
actions, editing, loading, streaming, failure, or cancellation SHALL remount the
reader on the newest retained turn.

The conversation SHALL use content-driven sizing bounded by the configured
maximum, growing through four, eight, and twelve up to that maximum, with
existing width degradation. Requested invocation peak SHALL be retained separately from
physical terminal height and effective renderer height. A physically short
terminal SHALL constrain the visible viewport without losing the requested
peak; restoring space SHALL restore that peak. The next invocation starts at
three rows. Details retain at least eight rows and never exceed the configured maximum.

#### Scenario: First accepted turn becomes a conversation
- **WHEN** the current Ask request produces one accepted validated final
- **THEN** one turn containing its submitted question and answer appears at the
  bottom of the conversation, the follow-up composer is focused and empty, and no
  local transcript is persisted or replayed

#### Scenario: Follow-up adds exactly one paired turn
- **WHEN** a follow-up resumes the exact provider session and its validated final
  is accepted
- **THEN** exactly one question-and-answer turn is displayed last, earlier visible
  turns remain reachable by scrolling up, and the request contains no replay
  of the visible list

#### Scenario: In-flight response names its question
- **WHEN** a submitted Ask question is loading or streaming
- **THEN** a bounded `You:` header identifies that question above the existing
  status or preview without becoming an accepted turn

#### Scenario: Conversation navigation is inert
- **WHEN** the user scrolls the conversation by keyboard or wheel
- **THEN** no provider call starts, no pointer or result changes, no command is
  inserted, and the composer draft and shell edit buffer remain unchanged

#### Scenario: Failed or cancelled follow-up preserves accepted turns
- **WHEN** a follow-up fails, is cancelled, becomes stale, returns malformed
  output, or never commits its pointer candidate
- **THEN** no turn is appended, every earlier accepted turn remains unchanged,
  the attempted question remains available for retry, and returning to the
  conversation exposes the newest accepted turn

#### Scenario: Retention drops only whole oldest turns
- **WHEN** accepting a turn would exceed 50 retained turns
- **THEN** the oldest whole turn is dropped, every retained question remains
  paired with its own answer, and the far-end scope line discloses the omission

#### Scenario: New chat keeps rollback authority invisible
- **WHEN** the user starts a new chat and its first request fails or is cancelled
- **THEN** the visible conversation stays empty, new-chat intent remains armed,
  and the previously committed provider pointer remains resumable

#### Scenario: Mode round-trip preserves armed new chat
- **WHEN** new-chat intent is armed and the user leaves Ask mode and returns
- **THEN** the visible conversation remains empty, the intent remains armed and
  textually disclosed, and no provider call starts

#### Scenario: Engine change clears only local display history
- **WHEN** the user changes the Ask engine while idle
- **THEN** the visible turn list and prior-question edit state clear, both engine
  pointers remain unchanged, and the selected engine's saved-chat state is
  rederived without restoring a local transcript

#### Scenario: Reopen resumes provider context without local transcript
- **WHEN** the workbench opens with a valid saved Ask pointer
- **THEN** it starts in the compact composer with no visible local turns and no
  provider call, and a later submission resumes through the pointer alone


### Requirement: Local workbench diagnostics
The workbench SHALL expose Doctor as the non-sending `D doctor` action only
when the underlying primary composer is idle in Ask, Command, or Fix while the
phase is ready, answer, analysis, failed, or cancelled. Ctrl-X D and the
action's clickable cell SHALL open the same view. Doctor SHALL NOT be offered
from loading, streaming, a candidate, editor, Settings, details, Doctor, or any
hidden composer. Composer text, including `/doctor`, SHALL retain the ordinary
provider path unchanged.

Opening Doctor SHALL synchronously guard the shared provider boundary and
preserve the active native textarea value plus its invocation-local React
draft before Doctor becomes visible. Doctor SHALL remain guarded until
dismissal has committed the main view, so a same-input-drain action or late
native content callback cannot submit or replace that draft. Dismissal SHALL
restore the same active composer text and phase; every other mode draft SHALL
remain unchanged.

Doctor SHALL capture exactly four local snapshot rows: the trusted cwd, the
selected provider, the inference-settings file, and the active provider's Ask
pointer. Each row SHALL begin with ASCII `PASS`, `WARN`, or `FAIL`. `PASS` SHALL
mean only that the named local predicate was satisfied at capture time; `WARN`
SHALL mean the path remains usable, degraded, or deliberately unverified; and
`FAIL` SHALL mean the current local state predicts a block of the named request
path. A configured provider SHALL be `WARN` because its argv was validated by
zsh at launch but is deliberately not rechecked. No row SHALL claim
authentication, entitlement, network, remote-model, provider-protocol,
transcript-store, or App Server health.

Doctor SHALL read only already trusted in-process or bounded local state. It
SHALL NOT execute a provider or command, contact a network, initialize, retire,
cancel, replace, or inspect the health of an App Server, build a provider
request, start an inference turn, emit a provider preview, write a result,
migrate or persist settings, repair state, or create, commit, replace, or
delete an Ask pointer or pending pointer. It SHALL NOT change conversation,
candidates, diagnosis, context, inclusion, another mode's draft, App Server
identity, or shell-buffer authority.

Doctor SHALL reuse the existing inspector renderer, promoted to the smallest
fitting of twelve rows and the configured maximum and bounded
Up/Down selection plus Left/Right value windowing. Escape, the existing
clickable `Esc back`, or Ctrl-X D SHALL dismiss it. Ctrl-C MAY close the whole
workbench through existing teardown. Every other keyboard or pointer input,
including Enter, Shift-Enter, Tab, mode/provider/model/effort ranges, Actions,
Settings chords, editing, new chat, disclosure, wheel input, and sending paths,
SHALL be consumed or ignored without changing state. In ASCII mode selection
SHALL use `>` and horizontal overflow SHALL use `<` and `>`; Unicode glyphs and
color MAY reinforce meaning but SHALL NOT carry it. Doctor SHALL remain bounded
inside an envelope that is the smallest fitting of twelve rows and the
configured maximum, without horizontal overflow at 80,
100, and 140 columns.

#### Scenario: Doctor action opens locally
- **WHEN** Ctrl-X D is invoked or `D doctor` is clicked from any eligible idle
  primary composer
- **THEN** Doctor opens with four bounded textual snapshot rows, the active
  draft is preserved, and no provider process, thread, or turn starts

#### Scenario: Slash text remains an ordinary query
- **WHEN** the composer contains `/doctor` and the user submits it
- **THEN** submission follows the existing provider path unchanged

#### Scenario: Same-drain actions cannot send Doctor
- **WHEN** Ctrl-X D is followed in the same input drain by Ctrl-X A or a late
  native content callback
- **THEN** the shared provider boundary remains guarded, no turn starts, and
  the preserved draft is neither replaced nor submitted

#### Scenario: Doctor is modal
- **WHEN** Doctor is visible and the user invokes any input other than bounded
  navigation, dismissal, or existing Ctrl-C teardown
- **THEN** no Actions, Settings, editor, mode change, new chat, disclosure,
  provider selection, request, or mutation occurs

#### Scenario: Doctor dismisses to the preserved composer
- **WHEN** Doctor is dismissed after entering from ready, answer, analysis,
  failed, or cancelled
- **THEN** the active composer text, phase, conversation, and diagnosis are
  preserved and the promoted footprint does not shrink

#### Scenario: Doctor is legible without Unicode or color
- **WHEN** Unicode or color is disabled at 80, 100, or 140 columns
- **THEN** all four rows remain inside the frame, status meaning stays textual,
  selection and overflow use ASCII markers, and no semantic information is
  lost

#### Scenario: Doctor leaves durable and provider state unchanged
- **WHEN** Doctor opens, is navigated, and is dismissed
- **THEN** pointer, pending pointer, settings, result, conversation, candidates,
  other drafts, App Server identity, provider-event baseline, and shell-buffer
  authority remain unchanged


### Requirement: In-flight reader navigation and reclamation
While an Ask, Command, or Fix preview is streaming, Up/Down, PageUp/PageDown, and wheel-over-reader
SHALL scroll without submitting a request or changing provider state. The reader
SHALL follow its tail until the user scrolls upward, retain the viewed sequence
across appends and prefix eviction when identifiable, and clamp to the oldest
retained text when the anchor is lost or ambiguous. Answer text SHALL remain
reachable when thoughts exceed the viewport, and a provisional channel label
SHALL remain visible. Escape SHALL still cancel and reap the active request.

#### Scenario: Closing after a sixteen-row peak
- **WHEN** the workbench closes after rendering its configured maximum height
  (twelve when unset)
- **THEN** its receipt records the maximum effective height, zsh accepts that
  receipt, preserves preceding scrollback and the original buffer/cursor when
  no command is selected, executes nothing, and the next invocation starts at
  three rows


### Requirement: Compact Command and Fix previews
Command/Fix streaming previews SHALL grow up to the smallest fitting of twelve
rows and the configured maximum, capped by available terminal height, while retaining their scrolling content. Finished candidates
may grow up to the configured maximum when their content needs it. Native frame height remains
monotonic; Ask streaming retains the configured maximum as its ceiling.

#### Scenario: Long previews finish with compact choices
- **WHEN** Command/Fix streams more than twelve rows of preview text
- **THEN** the preview scrolls within the smallest fitting of twelve rows and the
  configured maximum instead of promoting further
- **AND** a final result may promote to the configured maximum when needed for its content

## ADDED Requirements

### Requirement: Global maximum frame height
Settings SHALL offer a global maximum workbench frame height from 8, 12, and
16, defaulting to 12, persisted in global settings as one additive key. It
SHALL apply to the next invocation only: an open workbench SHALL NOT re-read
it, and frame height SHALL remain grow-only within an invocation. Every
workbench surface SHALL remain within the configured maximum.

#### Scenario: A saved maximum bounds the next invocation
- **WHEN** the user saves a maximum of 8 and opens a new workbench whose
  content would otherwise grow further
- **THEN** the frame grows only to eight rows and content beyond it remains
  reachable by scrolling
- **AND** the workbench that saved the value keeps its already-promoted height
  for the rest of that invocation

#### Scenario: A mid-invocation save does not apply live
- **WHEN** the user saves a higher maximum while a workbench is open at the
  old maximum and content arrives that would need the new maximum
- **THEN** the open workbench keeps the old bound, and after reopening the
  new bound applies

#### Scenario: The setting stays legible without color
- **WHEN** the palette renders the maximum-height leaves without Unicode or
  color
- **THEN** plain text carries the same offered values, default marker, and
  saved state

#### Scenario: Changing the maximum sends nothing
- **WHEN** the user saves a maximum height
- **THEN** no provider request starts and no existing candidate or
  conversation changes
- **AND** a failed settings write leaves the saved value, the current marker,
  and the open frame unchanged
