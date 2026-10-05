# ShellQ Specification

## Purpose

Define the observable behavior and safety invariants for host-side zsh command
generation, local failure hints, explicitly triggered correction, and
review-only command insertion through a configurable provider.

## Requirements

### Requirement: Local proactive hints
The plugin SHALL emit at most one dim local hint after status 127, 126, 130, or
a completed long-running command, without pane capture or an AI provider call.
For a completed long-running command, elapsed seconds SHALL be rounded once to
tenths and rendered as seconds below one minute, minutes plus seconds below one
hour, or hours plus minutes plus seconds at one hour or more; every rendered
seconds value SHALL retain one decimal place.

#### Scenario: Failed command hint
- **WHEN** a command finishes with status 127
- **THEN** one local command-not-found hint identifies Ctrl-O as the Fix action
  and no model call occurs

#### Scenario: Human-readable long-command duration
- **WHEN** a completed long-running command has an elapsed duration of 60,
  3599.9, 3600, or 3661.2 seconds
- **THEN** its local hint contains `1m 0.0s`, `59m 59.9s`, `1h 0m 0.0s`, or
  `1h 1m 1.2s`, respectively, and no model call occurs

### Requirement: Structured provider boundary
`SHELLQ_PROVIDER` SHALL remain an argv array whose command receives one JSON
request on stdin and returns exactly one mode-specific validated JSON object.
Command and Fix SHALL retain the existing `tldr`, `corrected_command`,
`confidence`, and `risk` candidate fields. Bundled workbench initial requests for multiple choices SHALL
opt into integer `candidate_count` from 2 through 5 and receive exactly
`{ "candidates": [...] }` with one to the requested number of validated candidates. An absent count or `candidate_count: 1` SHALL
retain the single four-field response for inline callers, configured custom
providers, and additional-candidate requests. Unsupported counts SHALL be
rejected before provider traffic. Ask SHALL NOT opt into batches. Ask SHALL receive `mode: "ask"`, a
bounded query, trusted structured environment metadata, and only explicitly
included captured output, and SHALL return exactly `{ "answer": string }`.
The plugin SHALL bundle a Codex adapter and a Claude adapter, each on that
identical contract.

Each registered provider SHALL preserve its adapter boundary: one-shot
providers SHALL use closed stdin, while the reusable Codex App Server exception
MAY keep only its correlated JSON-RPC transport open. Single Command and Fix requests SHALL
return the canonical command object directly; batch requests SHALL return the
candidates envelope; Claude SHALL not be forced
through the Ask `{ "answer": string }` envelope. Preview SHALL remain optional,
display-only, and non-authoritative; the final validated response, successful
exit, and provider-specific seal are the only authority for an answer,
candidate, or pointer commit.

Each bundled adapter SHALL have a stable, non-secret provider identifier
declared in a provider registry compiled into the plugin. A provider identifier
SHALL be established only by exact equality between the configured argv's first
element and the adapter path the registry itself computes from the plugin's own
installed location. It SHALL NOT be inferred from a basename, a path suffix, a
directory name, or any other property of a path the registry did not compute, so
an unrelated command that merely shares a bundled adapter's file name is never
treated as that provider and never receives its capabilities, settings, or
session state.

The registry SHALL declare, per identifier, which modes the provider supports —
Ask, Command, Fix — and whether stored conversation history for it is `native`
(the provider keeps its own transcripts), `owned` (shellq would keep them), or
`none`. Declaring `owned` SHALL NOT by itself cause shellq to store any
conversation content.

One registered provider SHALL be designated the bundled default. A registered
provider SHALL be selectable only when its command is present as an executable
file on `PATH`, determined by an in-process lookup. Whether that provider's
native conversation store already exists SHALL be determined by a single
non-following stat of a fixed store root; the root SHALL count as available only
when it is a directory that is not a symbolic link, and every other outcome —
missing, symbolic link, or any other file type — SHALL be reported as
unavailable without following it. That classification SHALL govern only the
availability of stored history and SHALL NOT affect selectability, so a freshly
installed CLI that has never run is still selectable. The plugin SHALL NOT
execute a provider's configured argv, and SHALL NOT execute a provider's CLI,
merely to enumerate providers, to determine what they support, or to build a
Settings list.

The shell SHALL supply, alongside the argv, whether `SHELLQ_PROVIDER` is the
value the plugin itself defaulted to or a value the user configured, determined
by comparing the live array against the plugin's own default at invocation time
rather than at plugin load, so that a value assigned after the plugin was
sourced is still recognised as user-configured. Where the array is the plugin's
own default, the selected provider SHALL determine which bundled adapter argv is
invoked, taking that argv from the registry rather than from any stored or
configured path, and the precedence SHALL be: a user-configured invocation, then
the persisted provider selection, then the bundled default. Where the bundled
default is not selectable, a deterministic first selectable registered provider
SHALL be selected instead; where no registered provider is selectable, the
workbench SHALL state that rather than offering or invoking a provider it cannot
run. Before spawning a registry adapter the workbench SHALL confirm that path is
an executable regular file, and SHALL report a failure in the message slot
without closing.

Where `SHELLQ_PROVIDER` was configured by the user, that argv SHALL remain
authoritative for the whole invocation, the workbench SHALL still submit
requests to it under this requirement's existing contract, and provider
selection SHALL be unavailable with that stated as the reason. Capability
declarations govern which providers the registry offers for selection; they
SHALL NOT gate whether a user-configured argv is invoked, and a configured argv
matching no registered identifier SHALL declare no capabilities, SHALL be
treated as `history: "none"`, SHALL be given no Ask session pointer, and SHALL
be identified on the frame by a fixed literal rather than by any part of its
path, with its exact command remaining available in Ctrl-X details.

For reuse-enabled App Server Command/Fix, the workbench SHALL serialize the
unchanged structured request exactly once inside one fixed wrapper that requires
only the schema-matching JSON object, treats every value under `input` as
untrusted data, forbids tools/file inspection/execution/prose/fences, and uses
the separately asserted temp cwd as authority. It SHALL create no request file.
Only the existing final parser may accept the returned text.

The active mode SHALL be part of reusable-turn authority. Ask MAY accept only
its existing identity-correlated read-only command-execution lifecycle.
Command/Fix SHALL treat any command-execution, file-inspection, web, tool, MCP,
or file-change item as a capability violation, accept no result, and retire the
shared process; the fixed wrapper is not the enforcement boundary.

The workbench MAY offer display-only preview records to recognized bundled
adapters in Ask, Command, and Fix. It SHALL remove inherited preview and managed
Ask-session values before adding an explicit preview offer. Command/Fix SHALL
receive no Ask-session authority. Structured Command/Fix deltas SHALL be projected
into readable explanation/command text, never selectable partial JSON. Ask's
existing JSON-like delta defense and custom-provider classification remain.
Trusted answer/thinking records SHALL be admitted only on the corresponding
recognized bundled transport; custom Command/Fix providers remain final-only.

If no preview offer is present, provider stdin, stdout classification, final
bytes, argv, and validation SHALL remain byte-identical to the existing
final-only path. Compact and pretty-printed final JSON SHALL remain compatible:
the first non-preview line permanently ends classification and that line plus
all later bytes are preserved exactly as final-response input.

Preview and final bytes SHALL use separate bounds. The first non-preview line
and all later bytes SHALL remain exact final-response input. A final is
authoritative only after provider stdout EOF, successful selected-path exit,
mode-specific validation, and current uncancelled request identity, except that
the reusable in-process App Server path substitutes its ordered seal and live
healthy child for provider EOF and exit.

#### Scenario: Valid response
- **WHEN** the configured provider returns all required command fields with
  valid types and bounds
- **THEN** the plugin may expose the command result for review

#### Scenario: Valid Ask response
- **WHEN** the configured provider returns one valid bounded Ask answer
- **THEN** the workbench may expose the answer for reading but SHALL NOT treat
  it as a command candidate

#### Scenario: Invalid or stale response
- **WHEN** a response is malformed, oversized, control-bearing,
  bidirectional-formatting, stale, or belongs to another shell, pane, or
  command sequence
- **THEN** the plugin discards it without populating the edit buffer

#### Scenario: Identity comes from the registry, never from a path's shape
- **WHEN** a configured command's path merely shares a bundled adapter's file
  name, or lies under a directory named after one, without equalling the path
  the registry computed
- **THEN** it resolves to no provider identifier, receives none of that
  provider's capabilities, settings, or session state, and is treated as a
  user-configured provider

#### Scenario: Provider identity survives relocation of the plugin
- **WHEN** the plugin itself is installed at a different absolute path than
  before and a bundled adapter is invoked from that new location
- **THEN** it resolves to the same provider identifier, because the registry
  computes the adapter path from its own installed location, and state recorded
  under that identifier remains attributed to it

#### Scenario: Enumeration executes nothing
- **WHEN** the plugin determines which providers are selectable and what they
  support
- **THEN** it performs only an in-process `PATH` lookup and one non-following
  stat of each fixed store root, starts no provider process, and starts no
  provider CLI

#### Scenario: A provider installed but never run is still selectable
- **WHEN** a registered provider's command is on `PATH` but its native store
  root does not exist
- **THEN** the provider is selectable, and only its stored-history availability
  is reported as absent

#### Scenario: A hostile store root is not reported as available
- **WHEN** a provider's store root is a symbolic link, a FIFO, a socket, or a
  regular file
- **THEN** stored history for it is reported unavailable, the root is not
  followed, and selectability is unaffected

#### Scenario: Only the bundled default is missing
- **WHEN** the bundled default provider's command is not on `PATH` and another
  registered provider's command is
- **THEN** the workbench opens with that other provider selected, and the
  feature remains reachable on a machine where the bundled default was never
  installed

#### Scenario: No registered provider is installed
- **WHEN** no registered provider's command is on `PATH` and the user has not
  configured one
- **THEN** the workbench states that no provider is available rather than
  offering or invoking one, without relying on color or Unicode

#### Scenario: The selected provider determines which adapter runs
- **WHEN** `SHELLQ_PROVIDER` was defaulted by the plugin and the user has
  selected a registered provider
- **THEN** the next request is submitted through that provider's bundled adapter
  argv taken from the registry, and no path from the settings file is invoked

#### Scenario: A user-configured provider stays authoritative
- **WHEN** the user has configured `SHELLQ_PROVIDER` themselves, whether before
  or after the plugin was sourced
- **THEN** that argv is invoked for every request in that invocation under the
  existing contract, the persisted provider selection is not applied, and
  provider selection is unavailable with the reason stated without relying on
  color or Unicode

#### Scenario: App Server is selected
- **WHEN** bundled Codex session state selects App Server with reuse enabled
- **THEN** one Bun-owned workbench App Server handles persistent Ask and
  ephemeral Command/Fix threads while direct paths remain on the existing
  provider

#### Scenario: App Server reuse is disabled
- **WHEN** bundled Codex selects App Server with `SHELLQ_APP_SERVER_REUSE=0`
- **THEN** Ask retains its existing one-shot App Server adapter and Command/Fix
  retain the exact existing provider path; mount starts no shared session

#### Scenario: Codex Exec is selected
- **WHEN** bundled Codex Ask session state selects Codex Exec
- **THEN** Ask invocation, environment, stdout, preview granularity, staging,
  and pointer behavior remain byte-compatible with the existing adapter

#### Scenario: Custom provider resembles the bundled head
- **WHEN** a custom argv starts with the bundled adapter path but has any extra
  element
- **THEN** its argv remains exact and it receives no bundled Engine row,
  pointer, managed Ask-session environment, or trusted answer-record privilege

#### Scenario: Valid streamed Ask response
- **WHEN** a recognized Ask adapter emits valid preview records followed by a
  valid final and its selected one-shot process exits zero or its reusable App
  Server session passes the ordered seal
- **THEN** previews remain display-only and only the validated final becomes the
  answer

#### Scenario: Legacy compact provider remains valid
- **WHEN** a custom provider emits one compact valid final JSON object and no
  preview records
- **THEN** the workbench validates it through the existing final-only path
  whether or not that provider ignored an Ask preview offer

#### Scenario: Legacy pretty-printed provider remains valid
- **WHEN** a custom provider emits one pretty-printed valid final JSON object
- **THEN** its opening non-preview line ends classification and the complete
  object is preserved and validated as final-response bytes

#### Scenario: Explicit bundled Command/Fix preview offer
- **WHEN** the workbench submits a managed bundled Command or Fix request
- **THEN** it explicitly offers streaming previews, displays readable provisional
  text and available thinking using the shared reader, and offers no insertion
  until the existing complete final-response validation succeeds
- **AND** cancellation or failure discards previews and restores retained valid choices

#### Scenario: Unoffered preview-shaped output remains final bytes
- **WHEN** a custom Command/Fix provider emits a preview-shaped line before its final
  object without a workbench preview offer
- **THEN** the combined malformed response is rejected without retaining a candidate
- **AND** direct bundled calls without an explicit preview offer retain final-only stdout

#### Scenario: Invalid or stale response
- **WHEN** a response is malformed, oversized, unsafe, stale, missing its final,
  truncated, or follows a nonzero selected-path exit
- **THEN** it is discarded without populating the shell buffer, replacing a
  committed answer, or changing a saved pointer

#### Scenario: Batch remains internal to the workbench
- **WHEN** the user accepts a candidate from a bundled batch
- **THEN** the shell receives only the selected four-field response, never the batch envelope

### Requirement: Context-sensitive correction insertion
Tab SHALL insert only a fresh correction for the current shell, pane, command
sequence, and untouched empty prompt; otherwise it SHALL delegate to the
previously bound Tab widget.

#### Scenario: Fresh correction on untouched prompt
- **WHEN** a matching correction is pending and the user presses Tab on an
  untouched empty prompt
- **THEN** the correction is inserted into `BUFFER` for review and `CURSOR`
  moves to its end

#### Scenario: Ordinary completion
- **WHEN** no matching correction is pending or the user has typed text
- **THEN** Tab delegates to the prior completion widget

### Requirement: Generated commands never auto-execute
The plugin SHALL NOT execute a generated or corrected command or invoke the ZLE
accept-line action.

#### Scenario: Command inserted for review
- **WHEN** generation or correction inserts a command into `BUFFER`
- **THEN** the shell waits for an explicit user action before execution

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
grow through twelve/sixteen as needed for the assessment, explanation, choice
separator, and selected command. Ctrl-X actions, editors, Provider Setup, and the
typed palette SHALL promote the footer to eight rows; Ctrl-X details and Doctor
SHALL promote it to twelve
rows. Ask loading, previews, and answers SHALL select the smallest fitting
4/8/12/16-row frame from rendered wrapped content. Footer height SHALL remain
capped at sixteen and monotonic during an
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
- **THEN** the footer grows to exactly eight rows and does not shrink again
  before the workbench closes

#### Scenario: First Ask preview promotes the invocation
- **WHEN** a loading Ask receives its first valid preview
- **THEN** the preview displays inside the content-driven footprint, capped at sixteen rows,
  which does not shrink if the request later succeeds, fails, or is cancelled

#### Scenario: Details promote the invocation
- **WHEN** Ctrl-X details becomes visible
- **THEN** the footer grows to exactly twelve rows and does not shrink again
  before the workbench closes

#### Scenario: Doctor promotes the invocation
- **WHEN** Doctor becomes visible
- **THEN** the footer grows to exactly twelve rows and does not shrink again
  before the workbench closes

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

### Requirement: Optional recent command context
The workbench SHALL keep the current cwd, repository-access capability, exact
last-command metadata, and bounded sanitized pane-output state available in its
non-mutating details view. Its resting bottom border SHALL always show a short
cwd in the left group; disclosure, when there are captured bytes, sits in the
bottom border's right group instead, immediately left of the Ctrl-X affordance
(see Scan-first workbench presentation), keeping the same position whether or
not a shown action is present. Repository read-only access, saved Ask state,
and last-command failure SHALL remain available only in details, never on
either border. Captured output with retained bytes SHALL be described in
human transmission terms as a toggle affordance naming what a click would do:
`Attach output` when the block is held back, or
`Output attached (~600 tokens)` when it is attached. The bounded amount SHALL
be reported as an approximate token count rather than a byte count, since what
the user is deciding about is how much of the model's context the attachment
will consume, and SHALL be marked as approximate — it is estimated from the
retained bytes, not produced by a tokenizer. It appears only in the attached
form, since that is also the only state in which it changes what a click would
do (detach rather than attach). The exact Included/Held state SHALL remain
available on the actions surface and in details. While captured output is
attached and the composer is the workbench's primary surface — never over a
candidate list, an Ask answer, an editor, details, Settings, or the actions
surface, which already own the body — the workbench SHALL show a bounded
preview of it above the composer: the tail (most recent lines) of the
sanitized text, at most three interior rows, each truncated to the interior
width by the same width-safe rendering the rest of the body uses, headed by a
short plain-text label that distinguishes it from an answer or a candidate
without relying on color or Unicode. Showing the preview SHALL promote the
footer to the eight-row envelope for the remainder of that invocation,
following the same monotonic rule as any other promoted state. It MAY
discover pane text locally on open but SHALL NOT invoke the provider,
calculate full Git status, serialize the repository, or transmit captured
output merely to populate these indicators. Progressive capture SHALL retain
the existing 80/160/320/640-line search tiers, 64 KiB search ceiling, 16 KiB
final limit, Herdr preference, and tmux fallback.

#### Scenario: Successful prior command
- **WHEN** the workbench opens after a successful command
- **THEN** its exact recorded command metadata remains available in details
  even though neither border ever shows a success indicator

#### Scenario: Ordinary prompt excludes prior pane text
- **WHEN** Ask or Command mode has captured pane text
- **THEN** the bottom border states the bounded amount as available to attach
  and the text is not sent unless the user explicitly includes it

#### Scenario: Fix includes prior pane text
- **WHEN** Fix mode opens for an actionable failure with captured pane text
- **THEN** the bottom border states the bounded amount as attached and the
  text is added to the submitted correction request

#### Scenario: User includes recent pane text
- **WHEN** the user previews and explicitly includes available recent context
- **THEN** only the displayed bounded sanitized text is added to subsequent
  requests in that workbench session

#### Scenario: Recorded command is located
- **WHEN** progressive local capture finds the exact recorded command before
  its hard limit
- **THEN** expansion stops and the details view labels the preview `matched
  command`

#### Scenario: Recorded command is not located
- **WHEN** progressive local capture reaches its hard limit without finding the
  exact recorded command
- **THEN** the newest bounded context remains available as `recent pane only`
  and is not represented as a complete command block

#### Scenario: Pane context is unavailable
- **WHEN** neither the recorded Herdr pane nor tmux capture is available
- **THEN** exact command metadata remains usable, details report output as
  Unavailable, neither border ever shows that negative default, and the
  context editor accepts explicitly pasted output

#### Scenario: User pastes context
- **WHEN** the user pastes terminal output into the editable context field
- **THEN** the workbench treats it as untrusted, sanitizes and bounds it like
  captured context, and sends it only after explicit inclusion

#### Scenario: Clipboard remains user-controlled
- **WHEN** no captured or pasted context is present
- **THEN** the workbench does not read the system clipboard automatically

#### Scenario: Bottom border's left slot yields to a transient message
- **WHEN** a provider error, a cancellation, a loading state, or an explicit
  confirmation (such as after toggling the block) exists
- **THEN** the bottom border's left slot shows that transient message in
  place of cwd, never alongside it

#### Scenario: A transient message returns to the response summary or cwd
- **WHEN** a transient message is showing in the bottom border's left slot and
  the user types a keystroke, submits, or changes surface
- **THEN** the left slot returns to the current response summary when available, or cwd
  otherwise

#### Scenario: Attached output previews above the composer
- **WHEN** captured output is attached and the composer is the workbench's
  primary surface
- **THEN** a bounded tail preview of the sanitized text appears above the
  composer behind a short plain-text label, and the footer promotes to the
  eight-row envelope for the remainder of the invocation

#### Scenario: Preview yields to a promoted surface
- **WHEN** a candidate list, an Ask answer, an editor, details, Settings, or
  the actions surface is showing
- **THEN** the attached-output preview does not render, since that surface
  already owns the body

#### Scenario: Preview is bounded to three rows
- **WHEN** the attached sanitized text has more than three lines
- **THEN** only its most recent three lines are shown, each truncated to the
  interior width by the same helper the rest of the body uses, and the
  preview never grows the frame to show more

### Requirement: Session-scoped inference controls

The Workbench SHALL display the selected Provider, Model, and Effort. `Ctrl-X
M`, `Ctrl-X R`, and `Ctrl-X G`, plus the Model/Effort top-rail ranges, SHALL
open the typed palette scoped to that field; `Ctrl-X S` and in-Workbench
Ctrl-K SHALL open its root. `Ctrl-X P` and the provider rail SHALL continue to
open Provider Setup. Both surfaces SHALL be unavailable while a provider
request is active, preserve an in-progress edit or composer draft, and restore
it unchanged on close.

The typed palette and Provider Setup SHALL share the provider registry,
invocation capability state, complete resolver, mutation, persistence,
retirement, and preparation paths. A successful changed selection SHALL apply
to the next request and persist globally across Workbench invocations and
directories; an Engine-only selection SHALL remain session-only. Neither
surface SHALL change shell variables, dotfiles, provider argv, provider
identity, or another invocation's in-memory selection. Opening either surface,
enumerating capabilities, loading or saving settings, falling back, migrating,
or discovering models SHALL make no inference request.

Available models and efforts SHALL come from the active provider's capability
state. A configured argv matching no registered provider SHALL retain only its
shell-supplied models and efforts and SHALL persist under one reserved scope
that contains no argv, path, or capability and is never treated as registered.
Where provider selection is unavailable, Provider Setup SHALL retain its
bounded explanatory provider row; the row SHALL remain inert.

The settings document SHALL be a sibling of the Ask pointer directory in the
private state root, mode `0600` under a mode `0700` directory, and bounded to
4,096 bytes. It SHALL contain only its declared version, selected provider, and
provider-scoped model and effort keys plus the optional validated private
localEndpoint configuration and optional localThinking endpoint/model/boolean
preferences and a global metricsExpanded boolean—never user content, captured output, cwd,
argv, or path. The Workbench SHALL reject a symlink, non-regular file,
oversized file, malformed content, or undefined key without throwing.

A saved provider/model/effort SHALL be validated independently against its
provider's selectable capability state. A still-available saved value SHALL
take precedence over the configured default. A managed-Codex current execution
tuple MAY retain the transport-safe provisional model and effort defined by the
Provider, model, effort, and engine contract even while discovery has not
advertised it. Any other unavailable saved value SHALL fall back by the
Structured provider boundary precedence and report that fallback exactly once
in the invocation's bottom-rail message slot.

Selections SHALL remain isolated per provider. Every write SHALL acquire the
portable cross-process lock without truncation, record owner PID, nonce, and
creation time, read and validate the latest file, merge the changed provider,
and atomically replace the file. A live owner SHALL block; a dead owner or an
old malformed lock MAY be reclaimed. Only the exact owner SHALL remove the
lock, on every success or failure path. An invalid or unreadable re-read SHALL refuse ordinary replacement. Only a
missing document MAY seed; explicit confirmed endpoint repair MAY replace an
invalid regular non-symlink document through the same safe transaction. The older flat shape SHALL migrate in place under the
bundled default provider, the only provider that could have written it, without
being reported as lost. An older build MAY later replace that migrated file
with its flat shape, discarding only re-selectable provider-scoped settings and
no user content.

A migration, read, lock, or persistence failure SHALL NOT block the in-memory
non-local change or crash the Workbench; it SHALL be reported with fixed
not-saved copy. Persistence-only failure SHALL NOT become retirement refusal
or block an otherwise usable request. Unresolved local endpoint, missing model
activation and actual retirement/preparation refusal retain their own guards.

#### Scenario: Defaults on open

- **WHEN** the Workbench opens and no valid saved Provider, Model, or Effort
  exists for the invocation
- **THEN** it selects the bundled default provider and that provider's
  configured model and effort defaults

#### Scenario: A saved selection wins on open

- **WHEN** the Workbench opens and a saved selection for the active provider
  remains selectable
- **THEN** it selects that value instead of the configured default without a
  provider request

#### Scenario: Settings opens focused on the requested field

- **WHEN** the user presses Ctrl-X M, Ctrl-X R, or Ctrl-X G, or clicks the
  Model/Effort top-rail range
- **THEN** the typed palette opens in that field's child view; Ctrl-X P or the
  provider rail instead opens Provider Setup, and neither starts a request

#### Scenario: Settings change

- **WHEN** the user chooses another selectable Provider, Model, or Effort
- **THEN** the next request uses it, the provider-scoped choice persists for
  later invocations, and no shell variable, dotfile, or other invocation's
  in-memory selection changes

#### Scenario: Switching providers keeps each provider's own model

- **WHEN** the user selects provider A with model A1, provider B with model B1,
  and then returns to provider A
- **THEN** A1 is restored, B1 remains saved, and neither is reported unavailable

#### Scenario: A concurrent write preserves another provider's entry

- **WHEN** two invocations change different providers after reading the same
  prior file
- **THEN** the lock serializes their read-merge-replace operations so the final
  document contains both committed entries

#### Scenario: A configured provider keeps its own settings scope

- **WHEN** an unregistered configured argv changes Model or Effort
- **THEN** only its shell-supplied choices are offered, its value persists under
  the reserved configured scope, no registered scope changes, and no argv or
  path is stored

#### Scenario: A legacy settings file migrates

- **WHEN** the settings file has the older flat model/effort shape
- **THEN** it migrates in place under the bundled default provider, applies when
  still available, and is not reported as lost

#### Scenario: A saved selection that is no longer available falls back once

- **WHEN** a non-provisional saved Model or Effort is absent from the active
  provider's selectable capability state
- **THEN** the configured default is selected and the fallback appears exactly
  once in the bottom-rail message slot

#### Scenario: A saved provider that is no longer installed falls back once

- **WHEN** the saved provider is no longer selectable
- **THEN** provider precedence selects the fallback, reports it exactly once,
  and submits no request to the unavailable provider

#### Scenario: Provider selection unavailable keeps its row

- **WHEN** Provider Setup opens while provider selection is unavailable
- **THEN** its explanatory provider row remains within the existing row budget
  and keyboard and pointer activation are inert

#### Scenario: An untrusted settings file is ignored

- **WHEN** the file is a symlink, non-regular, oversized, malformed, or carries
  an undefined key
- **THEN** the Workbench may fall back to non-local selections in memory without
  throwing; local endpoint stays unresolved without a valid override or explicit
  applied repair, no implicit default local traffic occurs, and ordinary writes
  never replace the damaged file

#### Scenario: A persistence failure does not block the change

- **WHEN** writing a changed selection fails
- **THEN** the in-memory selection remains active for the next request and the
  failure appears in the message slot

#### Scenario: Settings closes without losing a draft

- **WHEN** the user opens and closes the typed palette or Provider Setup over an
  unsaved edit or composer draft
- **THEN** the underlying edit or draft is restored exactly

#### Scenario: Settings is unavailable while busy

- **WHEN** a provider request is active
- **THEN** settings chords, rail ranges, and actions do not open either surface

#### Scenario: Settings selection is legible without color

- **WHEN** the typed palette or Provider Setup is open with color disabled
- **THEN** focus and current selection remain identifiable from text and inverse
  or bracket styling rather than color alone

#### Scenario: Custom provider opens Settings

- **WHEN** the configured provider argv matches no registered provider
- **THEN** its exact argv remains unchanged, only its configured Model and Effort
  choices appear, and no managed Codex pointer or environment is added

#### Scenario: Engine changes

- **WHEN** the user selects the other Engine in the typed palette
- **THEN** the complete guarded Engine transition applies, the palette retains
  its Engine surface behavior, and the next request uses only the selected
  routing and that Engine's own Ask pointer

#### Scenario: Engine changes after a successful turn

- **WHEN** the user changes Engine after an answer and later switches back
- **THEN** each Engine remains resumable through its untouched pointer while the
  prior visible transcript is not restored

#### Scenario: Scoped controls share the palette

- **WHEN** the user presses Ctrl-X M, Ctrl-X R, or Ctrl-X G while idle
- **THEN** the same typed palette opens in that field's child view with an
  empty query and no provider request

#### Scenario: Provisional Codex persistence is not discarded

- **WHEN** managed Codex reopens with a transport-safe persisted model or
  effort missing from fallback
- **THEN** the next request retains that current tuple provisionally while the
  palette reports it unavailable and offers only catalog-known replacements

#### Scenario: Configured provider can repair endpoint configuration

- **WHEN** an unregistered configured invocation opens endpoint configuration
- **THEN** it can confirm safe regular-file repair and later persist a configured
  selection without changing provider source/argv, model or reserved scope;
  inactive configuration grants no managed discovery or model/dispatch authority,
  a custom `SHELLQ_PROVIDER` invocation remains authoritative over any bundled
  default, and configured invocations never run managed discovery — the bounded
  GET-only round belongs to managed default invocations only

#### Scenario: Endpoint writes preserve concurrent selections

- **WHEN** endpoint and model writers acquire the shared lock in either order
- **THEN** latest valid root provider, endpoint and every unrelated provider entry
  survive, while invalid ordinary re-reads refuse replacement

#### Scenario: Invalid-file replacement is deliberate

- **WHEN** endpoint save/reset encounters an invalid regular non-symlink document
- **THEN** replacement requires the editor's warning and distinct confirmation,
  rechecks target and private parent under the shared lock, refuses unsafe paths
  or access failures, and preserves valid fields from any intervening repair

### Requirement: Explicit bounded alternatives
The workbench SHALL run at most one provider request at a time, SHALL
retain only validated distinct suggestions, and SHALL keep at most five
suggestions in memory.

#### Scenario: First suggestion
- **WHEN** the user explicitly requests a suggestion
- **THEN** one provider call starts with the displayed model and effort
  level

#### Scenario: Additional suggestion
- **WHEN** at least one suggestion is visible and the user explicitly requests
  another
- **THEN** one additional provider call starts and any valid distinct result is
  added without replacing earlier valid suggestions

#### Scenario: Duplicate suggestion
- **WHEN** an additional provider call returns a command already retained
- **THEN** no duplicate candidate is added

#### Scenario: Invalid suggestion
- **WHEN** a provider fails or returns a malformed or oversized response
- **THEN** no candidate is added and the original edit buffer remains unchanged

#### Scenario: Initial bundled batch is atomic
- **WHEN** an initial bundled Command or Fix request completes
- **THEN** one response contains three distinct useful approaches, or fewer when fewer safe approaches exist; all members must validate before any are admitted
- **AND** empty or excess arrays, extra member keys, malformed members, duplicate exact commands, and mixed null/non-null entries are rejected without admission
- **AND** Fix may return exactly one null-command candidate when no safe correction is supported

#### Scenario: Configured provider retains its contract
- **WHEN** a configured custom provider receives a first request
- **THEN** its request and response remain single-candidate, and explicit requests can add alternatives up to five

### Requirement: Interactive candidate review
Bundled Command and Fix modes SHALL request the saved initial count (default three) of distinct useful candidates
in one initial response, permitting fewer when fewer safe approaches exist,
SHALL admit only validated final candidates, and SHALL select a newly validated candidate without inserting it
into the shell edit buffer. Managed Command and Fix requests may offer progressive
previews, which never confer insertion authority. Exactly one additional candidate SHALL be requested per
explicit Ctrl-X A, and once two or more validated candidates are retained they
SHALL be presented as a navigable list within the promoted frame. The selected
candidate SHALL be shown with its real line structure across as many interior
rows as the promoted frame allows, while unselected candidates SHALL each
occupy one row so the list stays comparable; neither SHALL grow the frame
beyond its envelope. Every candidate row SHALL contain only a fixed-width selection/rank gutter and
command text. Candidates SHALL be ranked by validated numeric confidence
descending, retaining arrival order for exact ties. Initial batch admission SHALL select the highest-ranked candidate; successful
single admission SHALL select the new candidate by identity at its ranked position.
The first admitted response SHALL retain the full insertion teaching hint,
regardless of how many candidates it contains. Risk and provider confidence
SHALL share an assessment row above the scrollable selected-candidate
explanation; TLDR SHALL remain available in that explanation, and provider
confidence and risk SHALL also remain available in Details. The selected command SHALL be editable,
explicitly acceptable, and cancellable, and acceptance SHALL insert it for
review without executing it. Ask mode SHALL expose no candidate acceptance or
result-writing path, including while an Ask preview is visible.

#### Scenario: First candidate arrives selected but uninserted
- **WHEN** the first validated Command or Fix candidate arrives
- **THEN** it is selected and shown inside the frame, no accepted result is
  written, and the shell edit buffer is unchanged

#### Scenario: User requests one more candidate
- **WHEN** at least one candidate is visible and the user presses Ctrl-X A
- **THEN** exactly one additional provider call starts and any valid distinct
  result is ranked by descending confidence and selected by identity, without
  replacing earlier valid candidates; exact ties retain arrival order

#### Scenario: Two or more candidates become a list
- **WHEN** two or more validated candidates are retained
- **THEN** they are presented as a navigable list in the promoted frame with the
  selected entry identifiable without color

#### Scenario: Selected multi-line candidate shows its structure
- **WHEN** the selected candidate contains more than one line and the promoted
  frame has unused interior rows
- **THEN** its lines are shown on separate rows aligned under the command
  column, truncated with an ellipsis only when the available rows run out, and
  the frame does not grow beyond its envelope

#### Scenario: User edits a multi-line candidate
- **WHEN** the user opens the selected command editor and presses Enter
- **THEN** a newline is inserted without accepting, inserting, or executing the
  command, and Ctrl-X W remains the only action that saves the edit

#### Scenario: Candidate explains the correction
- **WHEN** a validated Command or Fix candidate is displayed
- **THEN** risk and provider confidence share one fixed assessment row above
  the scrollable explanation, and the labeled Choices block stays anchored above
  the bottom rail. Impact always starts a separate line with a muted label and
  a normal-contrast consequence, followed by a blank line and the TLDR. The
  explanation uses the remaining height and scrolls only when needed.
  PageUp/PageDown and the wheel scroll the explanation without changing
  selection; one-row readers move at least one row in either direction

#### Scenario: Provider cannot infer a safe correction
- **WHEN** a validated Command or Fix response contains a TLDR and a null
  corrected command
- **THEN** Fix retains any earlier candidates and their selection; without candidates,
  the promoted frame displays that explanation above a blank refinement
  composer and does not prefill, insert, or invent a command. Command requires
  a non-null command

#### Scenario: Unselected candidates stay one row each
- **WHEN** several candidates are retained and one is selected
- **THEN** every unselected candidate occupies exactly one row with its line
  breaks folded into a visible marker and only its rank/selection gutter

#### Scenario: Selected command accepted
- **WHEN** the user accepts a Command or Fix candidate whose edited response
  passes the parent plugin's validation
- **THEN** the frame closes, the exact command, including accepted trailing newlines, is inserted into `BUFFER`, `CURSOR`
  moves to its end, and the command is not executed

#### Scenario: Ask answer reviewed
- **WHEN** a validated Ask answer is visible
- **THEN** accepting, extracting, or inserting that answer as a command is not
  available

#### Scenario: Ask preview reviewed
- **WHEN** a display-only Ask preview is visible
- **THEN** accepting, extracting, inserting, persisting, or treating it as a
  candidate is not available

#### Scenario: Command and Fix previews never become candidates
- **WHEN** a Command or Fix request is active
- **THEN** readable previews may be displayed, but no partial provider output
  is admitted as a candidate; only the complete validated final response may
  add its candidates

#### Scenario: Workbench cancelled or fails
- **WHEN** the user cancels, interrupts, or the workbench cannot restore a
  valid command result
- **THEN** the renderer releases terminal input, the prompt is restored, and
  the original `BUFFER` and `CURSOR` remain unchanged

#### Scenario: Existing interactions remain available
- **WHEN** the workbench is not active
- **THEN** Ctrl-O, Tab completion, Atuin, terminal restoration, cancellation,
  and never-auto-execute behavior remain available without a shellq Alt binding

#### Scenario: Rejected alternatives leave review unchanged
- **WHEN** an alternative is duplicate, invalid, failed, cancelled, or stale
- **THEN** it changes neither retained candidates nor selection; a duplicate
  with higher confidence does not replace an existing assessment, and a sixth
  request is refused before invoking the provider

#### Scenario: Saved edits retain the original assessment
- **WHEN** the selected command is changed and saved
- **THEN** only its command changes, without reassessment, reranking, or result
  deduplication; the reader starts with an edited/not-reassessed qualification
  and Details shows the same warning. The warning persists through reversion
  and sorting until the candidate is cleared; an unchanged save does not create it

#### Scenario: Reader follows the selected candidate
- **WHEN** selection changes, a new candidate is admitted, or an edit is saved
- **THEN** the reader resets to its top even when index and TLDR are unchanged;
  clicking a row or selected continuation selects that candidate without
  requesting, accepting, writing a result, or executing a command

#### Scenario: Ranked current commands enter alternative context
- **WHEN** an additional candidate is explicitly requested
- **THEN** avoid_commands contains every retained current command, including
  edits, in ranked order; existing mode, palette provider/engine, Provider Setup,
  and same-provider model/effort reset distinctions remain unchanged

#### Scenario: ASCII candidate selection
- **WHEN** Unicode decoration is disabled
- **THEN** the selected rank gutter uses > instead of ›, while user-authored
  command characters remain unchanged and selection remains identifiable without color

#### Scenario: Initial alternatives teach different approaches
- **WHEN** bundled initial candidates arrive
- **THEN** the highest confidence candidate is selected, ties retain response order, and each TLDR explains purpose, important flags, and when to choose the approach within 500 characters
- **AND** confidence remains labeled as provider confidence, not a measured success probability
- **AND** candidate selection keeps `Enter insert (never runs)` visible when width permits, including later admissions

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
  remain within sixteen rows, no row overflows horizontally, contextual segments
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
- **THEN** it appears inside the frame in a bounded scrollable reader sized to content up to sixteen
  total frame rows above an immediately focused follow-up composer, and is not automatically
  written into ordinary terminal scrollback

#### Scenario: User scrolls a long Ask answer
- **WHEN** a validated Ask answer exceeds the visible reader rows and the user
  scrolls it
- **THEN** the answer viewport moves within the bounded answer without changing
  the query, invoking the provider, writing a result, or exceeding sixteen footer
  rows

#### Scenario: User edits the previous Ask question
- **WHEN** an Ask answer is visible and the user presses Ctrl-X E
- **THEN** the previous question opens in the promoted prompt editor, Enter
  inserts a newline without submitting, and Ctrl-X W saves it back to the
  focused composer without shrinking the retained eight-row frame

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
  twelve-row frame without closing the workbench, shrinking it, or changing its
  request state

#### Scenario: Ask preview stays in the workbench
- **WHEN** a valid display-only Ask preview is available while the request is
  active
- **THEN** it appears inside the frame in a bounded scrollable reader in the content-driven
  frame, up to sixteen rows, is identified as streaming without color, exposes only `Esc
  cancel` as the primary action, and is not printed to ordinary scrollback

### Requirement: In-flight suggestion cancellation
While any provider request is active, the workbench SHALL allow that request to
be cancelled without closing the workbench, accepting a candidate, writing an
Ask result, replacing a validated Ask answer or saved session pointer, or
modifying the shell edit buffer. Cancelling a streamed Ask SHALL discard its
request-local preview and staged pointer, reveal the previously validated Ask
answer, and prevent queued or late preview/final updates from winning. The
adapter SHALL stop and reap every selected-path provider, filter, and recorder
process and remove its FIFOs and temporary files. Normal workbench cancellation
SHALL remain available while no request is active.

#### Scenario: Escape cancels an active request
- **WHEN** the user presses Escape while a provider request is active
- **THEN** the request and all selected-path child processes are stopped, its
  preview and staged pointer are discarded, existing validated output and the
  active pointer remain unchanged, no result is accepted, and the workbench
  returns to an interactive idle state

#### Scenario: Late stream update follows cancellation
- **WHEN** a preview callback or valid final is queued before cancellation but
  attempts to update state after cancellation or a newer request token exists
- **THEN** the update is discarded without repopulating preview, replacing the
  answer, committing a pointer, or changing `BUFFER`

#### Scenario: Escape closes an idle workbench
- **WHEN** no provider request or editor/detail view is active and the user
  presses Escape
- **THEN** the footer closes, terminal input and the prompt are restored, and
  the original shell buffer and cursor remain unchanged

#### Scenario: Control-C closes the workbench
- **WHEN** the user presses Ctrl-C while the workbench is open
- **THEN** every selected-path provider, filter, and recorder process is
  stopped and reaped, staged state is removed, the footer closes, terminal
  input and the prompt are restored, and the original shell buffer and cursor
  remain unchanged

### Requirement: Read-only repository-aware Ask contract
Ask mode SHALL submit a bounded one-line query through a separate request
contract whose response is exactly `{ "answer": string }`. Every one-shot Ask
turn SHALL run with a read-only sandbox and closed stdin from an absolute
existing cwd supplied by the shell separately from request text. A reusable App
Server turn MAY keep its correlated JSON-RPC stdin open, but SHALL preserve the
same read-only authority and exact cwd contract. The provider workdir SHALL NOT
be derived from request JSON, model output, or user-authored prompt text. A
validated answer SHALL contain at most 8192 UTF-8 bytes, SHALL contain no unsafe
control or bidirectional-format characters, and SHALL have no accepted-command
or shell-buffer mutation path.

A bundled adapter SHALL configure that read-only sandbox explicitly and
fail closed: it SHALL NOT rely on a provider CLI's default, SHALL disable any
escape hatch that would let a command run unsandboxed, and SHALL fail the turn
rather than proceed when the sandbox cannot be established. Where a provider
CLI's sandbox covers only some of its tools, the adapter SHALL additionally deny
every tool that could mutate the filesystem, so no single layer is the only
thing standing between an Ask turn and a write. An attempted write during an Ask
turn SHALL leave the target unchanged.

A one-shot bundled adapter SHALL invoke its provider CLI in a mode that loads
no user-, project-, or locally-configured instruction file, hook, plugin, or
external tool server, so that none of them can execute during an Ask turn or
widen the read-only boundary. Both App Server launch paths and threadless discovery SHALL use a stable
ShellQ-owned `codex-home` under the state root and an allowlisted child environment.
They SHALL inherit no user/project configuration, AGENTS, skill prompts, hooks,
plugins, apps, or MCP startup. Authentication SHALL reference only an unambiguous
native file login by symlink without reading or copying credentials; keyring,
auto, ephemeral, unknown, and unresolved profile selection SHALL fail with actionable copy.
Administrator-managed policy on the host is outside the plugin's control and SHALL NOT be claimed as disabled.
Before every start/resume, ShellQ SHALL check configuration provenance and effective
MCP metadata, refuse active project or unexpected user layers and enabled MCP,
refresh exact skill paths for the cwd and disable each path, and require an actual
empty `instructionSources` array before inference. Every thread SHALL supply explicit
base/developer instructions, model/effort, read-only/no-network policy, and the
complete feature policy disabling plugins, apps, hooks, memories, multi-agent,
browser/computer use, image generation, and skill search. Ask alone SHALL enable
native shell inspection. Command/Fix SHALL disable shell_tool, unified_exec, and
view_image before inference and use an owned private empty cwd.

#### Scenario: Ask inspects the current repository
- **WHEN** the user submits an Ask query from a valid shell cwd
- **THEN** the active provider may inspect files and read-only Git state in that
  cwd without eagerly serializing or indexing the repository

#### Scenario: A one-shot Ask turn loads no external configuration
- **WHEN** a one-shot bundled adapter runs an Ask turn in a directory carrying
  project-level instruction files, hooks, plugins, or tool-server configuration
- **THEN** none of them are loaded or executed, and the turn's observable
  behavior is unchanged by their presence

#### Scenario: An Ask turn cannot write
- **WHEN** an Ask turn attempts to create, modify, or delete a file, by an
  editing tool or by a shell command
- **THEN** the attempt is refused, the target is unchanged, and the turn
  continues or fails without the write taking effect

#### Scenario: The sandbox cannot be established
- **WHEN** a bundled adapter cannot establish its read-only sandbox
- **THEN** the turn fails with that reported through the existing provider error
  path, and no unsandboxed provider process runs

#### Scenario: Ask workdir is invalid
- **WHEN** the separately supplied workdir is relative, missing, or not a
  directory
- **THEN** the workbench rejects it before invoking the provider and preserves
  the original shell buffer and cursor

#### Scenario: Ask answer is valid
- **WHEN** the provider returns one valid bounded Ask response
- **THEN** its answer appears in the answer card and no accepted result is
  written for the parent shell

#### Scenario: Ask answer is unsafe or oversized
- **WHEN** the provider returns a malformed, oversized, control-bearing, or
  bidirectional-formatting answer
- **THEN** the response is rejected without changing `BUFFER`

#### Scenario: Ask cannot become a command implicitly
- **WHEN** an Ask answer contains shell-like text
- **THEN** the workbench offers no extraction, acceptance, execution, or
  insertion action for that text

#### Scenario: App Server effective boundary is unavailable
- **WHEN** start or resume cannot assert required effective policy while
  preserving native file authentication and private thread storage
- **THEN** App Server does not begin the turn, both pointers and prior answer
  remain unchanged, and fixed UI copy directs the user to Ctrl-X G without
  changing the selected engine

#### Scenario: App-server turn crosses its safety boundary
- **WHEN** an unknown or forbidden capability, protocol method, item type, or
  server request appears after a turn begins
- **THEN** the turn stops safely, no output or candidate is accepted, and fixed
  UI copy directs the user to Ctrl-X G without changing the selected engine

#### Scenario: Ask preview is valid
- **WHEN** a bounded safe preview arrives before final authority
- **THEN** it may render only while current and cannot write an answer, result,
  pointer, shell buffer, or cursor

#### Scenario: Ask activity uses a fixed label
- **WHEN** an allowed read-only lifecycle event contains vendor detail
- **THEN** preview shows only the fixed activity label and none of that detail

#### Scenario: Installed authentication remains harness-owned
- **WHEN** a bundled provider handles Ask
- **THEN** the native provider owns authentication and refresh; ShellQ reads no
  credential payload, copies no tokens, and exposes no credentials in output

#### Scenario: App Server history remains private and resumable
- **WHEN** an isolated Ask thread is accepted and the workbench reopens
- **THEN** the same private native thread resumes using
  `ask/codex-app-server-isolated-<cwd-sha256>.json`, while legacy pointers and
  installed histories remain unchanged and are never imported or replayed

#### Scenario: App Server refuses inherited capabilities
- **WHEN** configuration, skill discovery, or instruction receipts cannot establish
  the required boundary, or unexpected MCP startup is observed
- **THEN** no turn/result/pointer is accepted and the selected engine remains unchanged

#### Scenario: Codex Exec remains isolated
- **WHEN** Codex Exec is selected for bundled Ask
- **THEN** its existing `--ignore-user-config` invocation and isolated
  configuration boundary remain byte-compatible

### Requirement: Resumable Ask conversations
The bundled adapters SHALL persist only successful Ask conversations, SHALL
resume only an exact validated provider session ID associated with the same
trusted cwd, and SHALL leave Command and Fix requests ephemeral. The workbench
SHALL store no provider transcript and SHALL make no provider call merely to
discover or display resumable state. The private state root MAY also hold one
global inference-settings file as a sibling of the per-cwd pointer directory;
that file carries no cwd, session, or provider-transcript data and is governed
entirely by the Session-scoped inference controls requirement, never by this
one.

Ask session pointers SHALL be stored one per provider identifier and trusted
cwd, and each pointer SHALL record the identifier of the provider whose
conversation it names. The workbench and the adapters SHALL read, replace, and
delete only the pointer belonging to the active provider for that cwd, and SHALL
NOT read, replace, or delete another provider's pointer. A pointer whose
recorded provider identifier is not the active provider's SHALL be refused
rather than resumed.

Preview records SHALL never create or change pointer authority. Each new Ask
turn SHALL use a request-unique mode-0600 regular non-symlink candidate and
shall validate its exact expected provider, session ID, and trusted cwd before
an atomic pointer replacement. Failure, cancellation, stale output, malformed
final output, nonzero exit, or seal failure SHALL remove only that request's
candidate. At submit time the workbench SHALL classify the selected pointer
once as missing, valid, or invalid, pass explicit new-chat or resume intent to
the adapter, and the adapter SHALL not reread the mutable pointer. Invalid
state SHALL block Ask until Ctrl-X N arms a new conversation.

Changing the selected provider while an answer, a candidate, or saved-chat state
from the previous provider is on screen SHALL clear that provider-derived state
and load only the new provider's pointer for the current cwd, while preserving
the user's own composer or editor text unchanged. A follow-up SHALL resume the
visible conversation only while the provider has not changed since that answer
arrived.

#### Scenario: First Ask creates resumable state
- **WHEN** no valid Ask session exists for the active provider and the trusted
  cwd, and the user submits a valid Ask query
- **THEN** one read-only session starts and its exact session ID is stored, with
  its provider identifier, in that provider's private cwd-scoped pointer, only
  after the turn succeeds

#### Scenario: Follow-up resumes the exact conversation
- **WHEN** an Ask answer is visible, the provider has not changed since it
  arrived, the user presses Enter, and submits a follow-up question
- **THEN** the blank composer submits the follow-up through the exact stored
  session ID without replaying a locally stored transcript

#### Scenario: Workbench reopens with saved context
- **WHEN** a valid Ask session pointer for the active provider already exists
  for the trusted cwd
- **THEN** Ctrl-O opens without a provider call, shows that chat context is
  saved, and the next Ask submission resumes that exact session

#### Scenario: Each provider keeps its own chat in one directory
- **WHEN** the user has an Ask conversation with provider A in a cwd, switches
  to provider B in that same cwd, and submits an Ask query
- **THEN** provider B's own pointer for that cwd governs — resuming it when it
  exists, or starting a new conversation and saying so when it does not — while
  provider A's pointer is left intact and resumes when provider A is selected
  again

#### Scenario: Switching providers with an answer on screen
- **WHEN** an Ask answer or candidate from the previous provider is visible and
  the user selects a different provider
- **THEN** that provider-derived state is cleared rather than shown under the
  new provider's label, the new provider's saved-chat state for the current cwd
  is loaded, the composer or editor text the user typed is preserved unchanged,
  and no provider call starts

#### Scenario: User starts a new Ask conversation
- **WHEN** the user selects new chat and submits a valid Ask query
- **THEN** a new session starts and replaces the active provider's pointer only
  after the new turn succeeds

#### Scenario: Persisted pointer is invalid
- **WHEN** the pointer is malformed, records a provider identifier other than
  the active provider's, contains an invalid session ID, or records a different
  cwd
- **THEN** the adapter refuses to resume it without silently selecting another
  session or weakening the read-only boundary

#### Scenario: Included output becomes conversation history
- **WHEN** the user explicitly includes captured or pasted output in a persisted
  Ask turn
- **THEN** only that displayed bounded text is sent and may remain in the
  provider-owned conversation history

#### Scenario: Command and Fix stay one-shot
- **WHEN** the user submits a Command or Fix request
- **THEN** the provider runs ephemerally and neither reads nor writes an Ask
  session pointer

#### Scenario: Persisted pointer is invalid
- **WHEN** an App Server pointer has extra or missing keys, wrong
  provider/cwd/ID, unsafe type, unsafe mode, or is a symbolic link
- **THEN** the workbench reports invalid local state and does not start, resume,
  or pick an Ask thread unless the user explicitly arms Ctrl-X N and submits a
  replacement; process initialization and ephemeral Command/Fix remain allowed

#### Scenario: Pointer changes after submit-time classification
- **WHEN** the active pointer changes after the workbench snapshots start or
  resume intent for a submitted request
- **THEN** that adapter process uses only its explicit intent and never rereads
  the active pointer as a second authority

#### Scenario: Remote conversation is missing
- **WHEN** a structurally valid pointer names a conversation that can no longer
  resume
- **THEN** the distinct resume failure retains the pointer for diagnosis and
  does not select by recency or start a replacement

#### Scenario: Previewed new conversation fails
- **WHEN** an armed new conversation is cancelled, fails, becomes stale, has an
  invalid final, or exits nonzero
- **THEN** only its request candidate is removed, the previous pointer stays
  resumable, the view stays cleared, and new-chat intent remains armed

#### Scenario: Concurrent managed candidates cannot cross-commit
- **WHEN** two same-cwd managed-provider requests stage different thread IDs
- **THEN** they use different candidate paths and each request may validate,
  remove, and commit only its own path

### Requirement: Main-screen footer reclamation
After every workbench exit with a valid prompt anchor and a current terminal
taller than the finalized peak footer height, the plugin SHALL release terminal
input and reclaim the former footer band from that validated peak before ZLE
redraws the prompt, SHALL preserve preceding terminal content and scrollback,
and SHALL NOT enter the alternate screen or leave a footer-height blank
reservation. If the terminal is resized after launch to the peak height or
shorter, the plugin SHALL preserve visible history and SHALL NOT issue a
full-viewport erase merely to reclaim the footer.

#### Scenario: Idle close reclaims the footer
- **WHEN** the user closes an idle workbench under supported geometry
- **THEN** the live prompt remains immediately after preceding shell content,
  allowing normal viewport scroll but without a duplicate prompt or an
  intervening footer-height blank band, and remains interactive

#### Scenario: Every exit shares restoration
- **WHEN** the workbench exits after cancellation, provider failure, accepted
  command, interruption, or invalid result with a valid anchor and sufficient
  current geometry
- **THEN** the same peak-based footer reclamation and existing buffer-restoration
  rules apply after the renderer has fully finalized

#### Scenario: Terminal becomes shorter than the finalized peak
- **WHEN** the terminal is resized after launch to no more rows than the
  finalized peak footer height
- **THEN** teardown restores terminal input and the shell buffer without
  clearing the entire visible viewport or replaying preceding history

### Requirement: Optional pointer input
The workbench MAY accept mouse input for mode selection, Provider Setup, the typed palette, candidate
review, and opening the actions surface. Every pointer affordance SHALL have a
keyboard equivalent, and pointer input SHALL be additive, never required.
Clicking a candidate row SHALL select it and SHALL NOT insert, execute, or
write an accepted result. Clicking the top border's provider, model, or
provider range SHALL open Provider Setup exactly as Ctrl-X P would. Clicking
the top border's model or effort range SHALL open the typed palette focused on
that field, exactly as Ctrl-X M or Ctrl-X R would. Clicking a provider value in
Provider Setup or an eligible value in the typed palette SHALL select it exactly
as its keyboard equivalent would, and SHALL NOT submit a request.
Clicking the bottom border's Ctrl-X range SHALL toggle the actions surface,
opening it when closed and closing it when open. Clicking the bottom
border's disclosure range — immediately left of the Ctrl-X affordance, after
any shown action — SHALL toggle captured-output inclusion, identically to
Ctrl-X I, and SHALL NOT send anything by itself. The bottom border's cwd (or
message) remains non-clickable. Clicking the bottom border's action range
SHALL act only when that action is dismissive — `Esc back` or `^X W save`;
an insertion action in either its full or taught short form, `Enter retry`,
and `Esc cancel` SHALL remain keyboard-only. No pointer action SHALL submit a
request, accept a candidate, write `resultPath`, or close the renderer. Wheel
scrolling over the candidate description or the Ask answer SHALL move only
that reader's viewport. Wheel scrolling over the composer or an open editor,
while it holds focus, MAY pan that textarea's own viewport and SHALL leave
its text, cursor position, and selection unchanged, and SHALL NOT submit a
request or change any candidate, result, or provider state. Wheel scrolling
anywhere else in the footer band SHALL do nothing, and a mouse report outside
the footer band entirely SHALL be ignored. Mouse reporting SHALL be enabled
only for the workbench's lifetime and every enabled reporting mode SHALL be
disabled at teardown. While the workbench holds mouse reporting, the
terminal's native drag-select and scrollback wheel behavior SHALL require the
terminal's own bypass modifier (for example Shift-drag).

In the typed palette, only a current painted eligible left click MAY focus or
apply through stable identity. Query, help, blank, loading, refusal,
unavailable, stale, wheel, and non-left click input SHALL be non-mutating;
pointer input SHALL be consumed while Applying.

#### Scenario: Candidate click selects without inserting
- **WHEN** the user clicks a candidate row
- **THEN** that candidate becomes selected, no result is written, and the
  shell edit buffer is unchanged

#### Scenario: Mode tab click switches mode
- **WHEN** the user clicks a mode tab that is not the current mode
- **THEN** selection switches to that mode without invoking the provider

#### Scenario: Click on the current mode tab is inert
- **WHEN** the user clicks the mode tab that is already selected
- **THEN** nothing changes

#### Scenario: Top border provider/model/effort click opens Settings
- **WHEN** the user clicks the top border's provider, model, or effort range
- **THEN** Provider Setup opens for provider while the typed palette opens
  focused on model or effort, exactly as the matching keyboard equivalent would,
  and no provider call starts

#### Scenario: Top border model/effort click opens Settings
- **WHEN** the user clicks the top border's model or effort range
- **THEN** the typed palette opens focused on that field, exactly as its
  keyboard equivalent would, and no provider call starts

#### Scenario: Settings provider row click selects that provider
- **WHEN** Provider Setup is open and the user clicks a provider value
- **THEN** that provider is selected exactly as its keyboard equivalent would
  select it, and no request is submitted

#### Scenario: Rail Ctrl-X click toggles the actions surface
- **WHEN** the user clicks the bottom border's `^X actions`/`^X` range
- **THEN** the actions surface opens exactly as it would from pressing
  Ctrl-X, and clicking that range again while it is open closes it

#### Scenario: Rail disclosure click toggles inclusion
- **WHEN** the user clicks the bottom border's captured-output disclosure
  range
- **THEN** inclusion toggles exactly as Ctrl-X I would, the label changes to
  name the opposite action, and no request is submitted

#### Scenario: Only dismissive rail actions are pointer-reachable
- **WHEN** the bottom border shows an insertion action (in either its full or
  taught short form), `Enter retry`, or `Esc cancel`, and the user clicks it
- **THEN** nothing happens, while a click on `Esc back` or `^X W save`
  performs exactly what the named key would

#### Scenario: Non-left click is ignored
- **WHEN** the user right-clicks or middle-clicks a clickable target
- **THEN** no action occurs

#### Scenario: Busy state ignores pointer input
- **WHEN** a provider request is active and the user clicks a mode tab, a
  candidate row, a Provider Setup value, or an eligible typed-palette row
- **THEN** no action occurs

#### Scenario: Wheel scrolls only the reader under the pointer
- **WHEN** the user scrolls the mouse wheel over the candidate description or
  the Ask answer
- **THEN** only that reader's viewport moves

#### Scenario: Wheel over a focused editor or composer pans it, nothing else
- **WHEN** the user scrolls the mouse wheel over the composer or an open
  editor whose content exceeds its visible rows, while it holds focus
- **THEN** only that textarea's own viewport moves; its text, cursor
  position, and selection are unchanged, no request is submitted, and no
  candidate, result, or provider state changes

#### Scenario: Wheel elsewhere in the band does nothing
- **WHEN** the user scrolls the mouse wheel elsewhere in the footer band,
  outside a scrollable reader and outside a focused composer or editor
- **THEN** nothing scrolls and no state changes

#### Scenario: Wheel above the footer band is ignored
- **WHEN** the user scrolls the mouse wheel over the terminal's own
  scrollback, above the footer band
- **THEN** nothing scrolls and no state changes

#### Scenario: Mouse reporting is scoped to the workbench lifetime
- **WHEN** the workbench opens
- **THEN** mouse reporting is enabled, and **WHEN** the workbench closes for
  any reason **THEN** every enabled reporting mode is disabled and ordinary
  terminal mouse behavior resumes

#### Scenario: Scrollback selection needs the terminal's bypass modifier
- **WHEN** the workbench holds mouse reporting and the user wants to select or
  scroll ordinary terminal scrollback above the footer band
- **THEN** the terminal's native bypass modifier (for example Shift-drag) is
  required, and plain drag-select resumes once the workbench closes

#### Scenario: Inert palette pointer input stays inert
- **WHEN** the user clicks any non-eligible or stale row, wheels, or uses a
  non-left button
- **THEN** no focus, mutation, persistence, request, preparation, or provider
  state changes

### Requirement: Response timing and reported metrics
At rest with no response summary, the footer SHALL show cwd. During a request it
SHALL show Waiting, Thinking or Answering and elapsed time from a monotonic clock.
Activity SHALL reflect received events independently of thinking visibility.
An accepted Ask answer SHALL replace routine completion chatter with elapsed
time. Actionable errors and settings feedback SHALL take priority and SHALL not
be erased by subsequent preview events or successful Ask completion.

Metrics SHALL default to expanded. Clicking SHALL atomically save a global
metricsExpanded boolean in the existing private settings document, preserving
other fields and write safeguards. It SHALL apply across chats, providers and
future openings; starting a request SHALL not reset it. On a write failure the
display preference SHALL stay unchanged and show an actionable message.
Clicking the completed timing SHALL expand/collapse backend-reported output
token count and generation speed without submitting, inserting or changing
focus. Ctrl-X H Details SHALL expose the full summary and observed time to first
text, including on narrow terminals. Metrics SHALL never be estimated from text
length or by dividing tokens by client wall time. Unavailable values SHALL be
omitted. Only finite positive speed and nonnegative safe-integer token counts
SHALL be admitted. Summary state SHALL reset for a new request or provider/model/
mode selection; failed or cancelled turns SHALL not receive successful metrics.

Managed local Ask MAY emit one `{t:"metrics",metrics:{...}}` record before the
final answer only after complete HTTP/SSE framing and final content validation.
Its only allowed metric keys SHALL be outputTokens and tokensPerSecond. The
parent SHALL admit this record only on its explicit local metrics path, under
existing preview line/input bounds, and display it only after final acceptance.
It SHALL not enter answer prose, history, provider requests, shell buffers,
result files or saved preferences. The local adapter MAY consume a usage-only
SSE event with empty choices after a finish event and before DONE. Ordinary
provider paths SHALL retain their existing final-answer grammar.

#### Scenario: Accepted response uses the saved display choice
- **WHEN** a response is accepted with reported token counts and generation speed
- **THEN** the footer shows elapsed time with metrics expanded by default, and a
  clicked display choice persists globally across chats and future openings

### Requirement: Chat reader scrollbar
Streaming and completed Ask readers SHALL show a slim vertical scrollbar inside
the right edge only while content overflows. Its thumb SHALL reflect the live
viewport, offset and content length after new chunks, wrapping and resizing.
Keyboard and wheel scrolling SHALL update it; clicks and drags SHALL navigate
without starting a request, inserting text or moving focus from the composer.
It SHALL use the existing frame and retained grow-only height, with a reserved
reader gutter preventing overlap with answer text.

#### Scenario: Overflowing reader supports navigation
- **WHEN** streaming text or completed chat history overflows the reader
- **THEN** a scrollbar appears inside the right gutter, tracks the live viewport,
  and supports scrolling, clicking, and dragging without starting a request

### Requirement: Progressive Ask preview
For workbench Ask requests only, provider stdout MAY carry zero or more
LF-terminated preview records before exactly one final response. Each preview
record SHALL be a JSON object with exactly `t` and `text`. The ordinary grammar
SHALL allow `t:"delta"` and `t:"note"`; the recognized bundled App Server and managed local Ask
paths MAY additionally allow `t:"answer"`. Only managed local Ask MAY allow
`t:"thinking"` from explicit model `reasoning_content`. `text` SHALL be a string. A `delta`
or trusted `answer` SHALL append sanitized human-facing prose; a `note` SHALL
replace only the trailing activity label. The workbench SHALL reject trusted
`answer` records from Exec and custom providers. Preview content SHALL remain
display-only and SHALL NOT become an answer, candidate, accepted output,
`BUFFER`, `resultPath`, or Ask session state. A turn with no preview SHALL retain
the existing final-only behavior.

The workbench SHALL frame preview candidates on raw LF-delimited bytes, SHALL
fatal-decode only a candidate preview line, and SHALL stop preview
classification permanently at the first complete line that is not an exact
preview record or an explicitly admitted local metrics record. It SHALL bound one preview line to 8192 bytes, accepted preview
display input to 262144 bytes, and rendered preview text to the existing 8192
UTF-8-byte Ask answer bound. After the display-input budget is exhausted, it
SHALL continue recognizing and discarding preview records in constant memory
until final bytes begin, without failing an otherwise valid turn.

A preview `note` SHALL contain only a fixed adapter-authored label. It SHALL NOT
contain vendor-derived commands, paths, queries, arguments, tool payloads, tool
results, reasoning, lifecycle JSON, authentication data, or other raw vendor
event content. Ordinary model-derived `delta` text SHALL be sanitized and
conservatively suppressed when JSON-like. Trusted `answer` text
SHALL preserve sanitized JSON-like prose and code because the adapter has
already selected answer text from the relevant response field. Managed local
Ask SHALL extract decoded answer-string characters and preserve incomplete
escapes across events. Thinking SHALL be separately labeled model-provided and
provisional, share the aggregate display bound, and never enter final results,
history, prompts, pointers, settings, or shell buffers. Both channels SHALL
clear on completion, failure, cancellation, and reset. Escape/control sequences
SHALL remain safely sanitized across event boundaries.
Suppression SHALL NOT affect final-response processing.

#### Scenario: First safe preview arrives
- **WHEN** an Ask provider emits one valid preview record before its final
  response
- **THEN** the workbench displays the decoded `text` without showing normalized
  record syntax and without changing committed answer or session state

#### Scenario: Trusted App Server answer preview arrives
- **WHEN** the recognized bundled App Server emits a valid `t:"answer"` record
  containing prose, JSON, or code
- **THEN** the workbench preserves its sanitized text as display-only preview
  while Exec and custom providers remain unable to use that record type

#### Scenario: Preview spans transport chunks
- **WHEN** a valid preview record or multi-byte UTF-8 character is divided
  across stdout chunks
- **THEN** the workbench retains incomplete raw bytes, decodes the complete line
  once, and displays the same preview text as an unsplit record

#### Scenario: Final answer differs from preview
- **WHEN** an Ask turn previews text and later exits successfully with a
  different valid `{ "answer": string }` response
- **THEN** the validated final atomically replaces the preview and alone becomes
  authoritative

#### Scenario: Ask produces no preview
- **WHEN** an Ask provider ignores the preview offer or emits no qualifying
  preview before a valid final response
- **THEN** the turn succeeds with the same observable final-answer behavior and
  exact final bytes as the legacy final-only path

#### Scenario: Preview display budget is exhausted
- **WHEN** recognized preview input exceeds 262144 bytes before final bytes
- **THEN** display stops updating, later exact previews are discarded in
  constant memory, and a later valid final can still succeed

#### Scenario: Model text is JSON-like
- **WHEN** an ordinary `delta` begins like an object, array, or fenced block, or
  contains a quoted-key-and-colon JSON pattern
- **THEN** it is not displayed and the adapter MAY emit only the fixed
  `Drafting the answer` note in its place

#### Scenario: Activity event contains sensitive tool input
- **WHEN** a vendor activity event contains a command, path, query, argument,
  tool payload, result, or canary secret
- **THEN** none appears in preview stdout or a rendered frame, and only an
  allowlisted fixed label MAY appear

#### Scenario: Preview cannot become authority
- **WHEN** a previewed turn is cancelled, fails, becomes stale, is truncated,
  lacks a final response, or exits nonzero
- **THEN** every preview is discarded and no answer, candidate, accepted
  result, `BUFFER`, `resultPath`, or pointer is created or replaced

### Requirement: Ctrl-first interaction grammar
Ctrl-O SHALL open the universal workbench. Custom workbench accelerators SHALL
use a Ctrl-X prefix, while standard Tab, Shift-Tab, Enter, arrow, Escape, and
Ctrl-C behavior SHALL remain available. Ctrl-X P SHALL open Provider Setup.
Ctrl-X S and in-Workbench Ctrl-K SHALL open the typed palette root; Ctrl-X M,
Ctrl-X R, and Ctrl-X G SHALL open its model, effort, and engine child views.
Ctrl-X P SHALL remain reachable by its chord, by the top border's provider
range, and by name on the actions surface's header row, and SHALL NOT occupy an
actions-surface grid cell. Optional pointer input MAY provide an additive
equivalent for a mode switch, opening Provider Setup or the typed palette,
changing an eligible value, opening the actions surface, or selecting a
candidate, but SHALL NOT be required for any workbench action. The plugin SHALL
add no top-level ZLE Ctrl-K or Ctrl-P binding, SHALL expose no Alt-based binding
of its own, and SHALL NOT inspect or remove an Alt binding installed by anything
else.

Installing the Tab binding SHALL record the previously bound widget so the
accept-or-complete fallthrough can delegate to it, and SHALL skip recording
the plugin's own widget so that reloading cannot make that fallthrough recurse
into itself.

#### Scenario: Universal invocation
- **WHEN** the user presses Ctrl-O in a supported ZLE keymap
- **THEN** the deterministic Ask, Command, or Fix workbench opens

#### Scenario: Custom workbench action
- **WHEN** the user presses Ctrl-X followed by a documented mnemonic key while
  the workbench is idle
- **THEN** exactly that context, inclusion, Provider Setup, typed palette, details, edit,
  alternative, save, provider, or new-chat action occurs without submitting
  implicitly

#### Scenario: Pointer input is additive
- **WHEN** the workbench is idle and a pointer is available
- **THEN** clicking a mode tab, the top border's provider, model, or effort
  range, the bottom border's Ctrl-X range, a candidate row, or an eligible
  Provider Setup or typed-palette value
  performs the same action as its keyboard equivalent, and no workbench action
  is reachable only by pointer

#### Scenario: Standard terminal action
- **WHEN** the user presses Tab, Shift-Tab, Enter, an arrow, Escape, or Ctrl-C
- **THEN** the existing mode, submission/navigation, cancellation, or close
  behavior occurs without requiring a custom Ctrl chord

#### Scenario: Alt is left alone
- **WHEN** the plugin loads in a keymap that has Alt-O or Alt-E bound to
  anything at all
- **THEN** it installs no Alt binding and leaves the existing ones untouched

#### Scenario: Reload preserves the user's prior Tab widget
- **WHEN** the plugin loads a second time in a shell where it already bound Tab
- **THEN** the recorded prior widget remains the one the user had before the
  first load, and the plugin's own widget is never recorded as that prior

#### Scenario: Engine Settings shortcut
- **WHEN** exact bundled Codex is active and the user presses Ctrl-X G
- **THEN** the typed palette opens focused on Engine without sending or
  changing the selected value

#### Scenario: Direct chords bypass More
- **WHEN** the user presses Ctrl-X M, Ctrl-X R, or Ctrl-X G
- **THEN** the matching child opens directly without first entering More and
  without starting a provider request

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

The conversation SHALL use content-driven 4/8/12/16-row sizing and existing
width degradation. Requested invocation peak SHALL be retained separately from
physical terminal height and effective renderer height. A physically short
terminal SHALL constrain the visible viewport without losing the requested
peak; restoring space SHALL restore that peak. The next invocation starts at
three rows. Details retain their twelve-row minimum.

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

### Requirement: Contextual Actions eligibility and safety
The Actions surface SHALL derive its painted cells, terminal-cell geometry,
visible contextual action set, keyboard eligibility, and pointer hit ranges from
one render model. A cell whose action starts a provider request SHALL remain
keyboard-only, SHALL be textually marked `key only`, and SHALL emit no pointer
hit range. No pointer action SHALL start a provider request. The sending
alternative SHALL be eligible only when the live Command or Fix draft is valid,
the selected request exists, and fewer than five candidates are retained.

The header SHALL state `Actions · only A sends · Esc close` only when the
sending alternative is eligible. It SHALL state
`Actions · nothing sends · Esc close` in Ask or whenever no sending alternative
is eligible, and `Editing <editor target> · nothing sends · Esc close` while
editing, where the target is `question`, `prompt`, `command`, or `output`. The
generic instruction to click a row or press its letter SHALL NOT be required.
Every visible non-sending cell SHALL perform exactly what its label states; a
cell whose label names a save precondition SHALL remain unavailable until the
edit is saved. Only actions in the visible contextual set SHALL resolve through
Ctrl-X.

Each column SHALL truncate its own content to its terminal-cell budget before
the divider is painted, SHALL preserve a separator between labels and values,
and SHALL compute hit ranges from the painted cell widths. A long or wide model
identifier SHALL NOT move a divider away from its hit boundary or leave an
invisible action clickable. The surface SHALL remain within six interior rows
at supported widths.

While an edit is unsaved, a request to switch to another editor target SHALL
leave the editor and its text unchanged and SHALL report
`save or discard the edit first`. A request to switch modes by Tab, Shift-Tab,
or pointer SHALL likewise leave the editor, its text, and the current mode
unchanged and report the same message; Escape remains the single-key discard.
An Ask engine change reached through the typed palette while an edit is
unsaved SHALL be
refused under the same save-or-discard invariant. An unknown Ctrl-X letter SHALL
close Actions and report `unknown ctrl-x chord` after either keyboard or pointer
opening.
Actions SHALL NOT teach PageUp/PageDown because those keys are intercepted while
it is open; candidate-scroll teaching MAY appear only where the candidate reader
is actually scrollable and the existing rail budget permits it.

The existing textual `S settings` discoverability MAY open the typed palette
only while idle and SHALL never submit, insert, mutate a result, or start a
provider request.

Operational meaning SHALL NOT rely on color, Unicode, or pointer input. Optional
theme styling SHALL NOT change the surface's character frame or its click
geometry. The existing `^X actions` rail label,
`Actions` surface name, two-column renderer, frame envelope, and invocation-local
Ask conversation lifecycle SHALL otherwise remain unchanged.

#### Scenario: Sending alternative is keyboard-only
- **WHEN** non-editing Command or Fix Actions shows `A another suggestion`
- **THEN** its header says only A sends, the cell is marked `key only`, pressing
  its visible letter starts exactly one request, and clicking any part of that
  cell starts no request

#### Scenario: Unavailable alternative is absent
- **WHEN** a Command or Fix alternative cannot start because its live draft is
  invalid, its request is unavailable, or five candidates are retained
- **THEN** A is absent from the visible and keyboard-eligible action sets and the
  header says nothing sends

#### Scenario: Ask and editing send nothing
- **WHEN** Actions is open in Ask or while any edit is unsaved
- **THEN** the header says nothing sends, no visible or hidden letter starts a
  provider request, and the current draft or editor text remains unchanged

#### Scenario: Visible set governs both opening paths
- **WHEN** Actions was opened by Ctrl-X or by clicking the rail and the user
  presses a letter
- **THEN** the action resolves only when it belongs to that rendered contextual
  set, with identical behavior after either opening path

#### Scenario: Non-sending click matches its letter
- **WHEN** the user clicks a visible non-sending Actions cell
- **THEN** exactly the action that cell's visible letter would perform occurs,
  using a hit range computed from the same painted cell

#### Scenario: Wide values cannot create invisible targets
- **WHEN** a model label contains 8, 16, 17, or 40 terminal cells or wide Unicode
  at 80, 100, or 140 columns in Unicode or ASCII mode
- **THEN** each divider and hit boundary matches the painted terminal cells, no
  row overflows, and no absent or invisible cell has a hit range

#### Scenario: Unsaved editor switch is refused
- **WHEN** the user requests the context editor from an unsaved prompt or command
  edit, or requests the prompt or command editor from an unsaved context edit
- **THEN** the current editor stays open with byte-identical text and the frame
  says `save or discard the edit first`

#### Scenario: Unsaved mode switch is refused
- **WHEN** the user presses Tab or Shift-Tab or clicks another mode while an
  edit is unsaved
- **THEN** the current mode and editor stay open with byte-identical text and
  the frame says `save or discard the edit first`

#### Scenario: Unknown letter behavior is symmetric
- **WHEN** the user presses an unmapped letter after opening Actions by keyboard
  or pointer
- **THEN** Actions closes, `unknown ctrl-x chord` appears, and no other state or
  provider request changes

#### Scenario: Actions copy teaches only live behavior
- **WHEN** Actions is open in any supported state
- **THEN** `Esc close` remains visible, no PageUp/PageDown instruction appears,
  every sending claim matches the contextual eligible set, and the surface uses
  at most six interior rows

#### Scenario: Actions settings discovery is local
- **WHEN** idle Actions resolves its existing textual S settings entry
- **THEN** the typed palette root opens locally without changing the Actions
  grid or starting send, insertion, result, or provider work

### Requirement: Workbench App Server session ownership
When App Server is the selected bundled Codex engine and reuse is enabled, the
workbench SHALL asynchronously initialize one private process on mount in every
initial mode. It SHALL start or resume one non-ephemeral Ask thread by exact ID
at the trusted cwd when the pointer decision permits, and SHALL start one new
ephemeral thread at the private empty cwd for each Command/Fix request. It SHALL
serialize turns and SHALL keep at most the Ask thread plus the current
Command/Fix thread active. Preparation SHALL NOT block rendering or start a
turn, preview, candidate, or pointer commit.

The workbench SHALL compute the Command/Fix cwd once per process as the
owned empty directory under the stable private Codex home and SHALL reuse that
exact string for thread start, turn start, effective-policy assertion, and
ordered seal. Before a thread's first turn, start or resume SHALL verify that
thread's exact cwd, ephemeral state, model, reasoning, approvals-never,
read-only sandbox, and network-off state. Warm follow-ups SHALL reapply their
settings in `turn/start`, fail closed on `thread/settings/updated`, and rely on
the ordered seal because App Server exposes no per-turn policy echo. A mismatch
SHALL accept no result and retire the process.

Every reusable Ask, Command, or Fix turn SHALL require a matching completed
final agent item, a matching completed turn with no active agent item, and an
ordered matching `thread/read { includeTurns: false }` response confirming the
selected thread, its exact cwd, idle status, and a live child before transport
authority. Only the existing mode-specific parser may then accept the raw final.

The Ask adapter SHALL convert the structured request into a fixed prose
contract targeting at most 6000
UTF-8 bytes with an absolute 8192-byte ceiling, SHALL emit only
identity-correlated display-only answer previews, and SHALL treat a matching
completed final-answer or phase-unknown agent item followed by a matching
completed turn with no active agent item and an ordered matching
`thread/read { includeTurns: false }` response confirming the selected thread,
cwd, and idle status as the only reusable-session final authority. A one-shot
session SHALL retain stdout EOF and clean process exit as its authority.
Only an agent item explicitly phased `final_answer` at start MAY emit preview
deltas; phase-unknown text SHALL remain withheld until final validation.
Commentary SHALL never become answer text. It
SHALL tolerate validated routine notifications with their required thread/turn
identity, including notifications during configuration and skill preparation.
Every MCP startup notification SHALL fail closed, including late notifications
from previously sealed threads. No configured-tools startup label SHALL appear.
User-message, reasoning, plan, and context-compaction lifecycle events MAY be
ignored without making their closure a final-answer authority condition.
It SHALL NOT select a thread by
recency, replay a local transcript, satisfy a server request, accept an unknown
protocol method or item type. A reusable child MAY remain idle before the first
turn while preparing, or after success for an exact same-thread/cwd/model/effort
valid-pointer follow-up. It SHALL be reaped after cancellation, timeout/failed
turn, failed seal, protocol/policy/identity/capability violation, stream/child
failure, pointer commit failure, incompatible state, or workbench teardown. A
clean transport seal followed only by mode-specific parser, bounds, safety, or
deduplication rejection SHALL discard that result while keeping the process
healthy.

#### Scenario: Mount prepares the workbench session
- **WHEN** a reuse-enabled App Server workbench mounts initially in Ask,
  Command, or Fix and its Ask pointer is valid, missing, or invalid with
  explicit new-chat intent armed
- **THEN** it initializes exactly one private process and prepares the exact Ask
  thread without blocking the TUI, starting a turn, emitting output, creating a
  candidate file, or committing a pointer

#### Scenario: Invalid Ask state does not block Command or Fix
- **WHEN** the App Server pointer is invalid without explicit new-chat intent
- **THEN** mount initializes the private process but withholds the Ask thread,
  Ask stays blocked by the existing diagnosis, and Command/Fix may still use
  their ephemeral threads

#### Scenario: Saved Ask thread cannot resume
- **WHEN** a structurally valid saved pointer names a thread App Server cannot
  resume
- **THEN** the pointer remains unchanged for diagnosis, the initialized process
  remains available for Command/Fix ephemeral turns, and the next Ask reports
  the distinct resume failure without accepting output

#### Scenario: Submit races session preparation
- **WHEN** the user submits while the exact selected session is still preparing
- **THEN** submission awaits and reuses that one process and thread, starts no
  duplicate child, and applies the submitted request through the normal turn
  validation and authority path

#### Scenario: Prepared session becomes incompatible
- **WHEN** preparation fails, engine/model/reasoning/new-chat state changes, the
  pointer diverges, or the workbench closes
- **THEN** no provider error is shown before submit, no turn or pointer state is
  accepted, and the selected child is aborted and reaped before replacement

#### Scenario: First App Server Ask starts a saved thread
- **WHEN** no valid App Server pointer exists and the user submits an Ask query
- **THEN** one non-ephemeral read-only thread starts, matching answer text may
  stream display-only, and its exact ID is staged only after final authority

#### Scenario: Follow-up resumes across processes
- **WHEN** a valid App Server pointer exists and the user submits a follow-up
- **THEN** an exact compatible idle session continues that thread without a
  new process, or a new adapter/session resumes only that exact ID; both paths
  reapply the cwd/model/reasoning/approval/sandbox/network boundary and send no
  local transcript

#### Scenario: Warm follow-up reuses one private session
- **WHEN** the selected engine, valid pointer ID, cwd, model, effort, and live
  idle session all match after a sealed successful turn
- **THEN** the next Ask uses that same private app-server process and thread
  and starts no second app-server process

#### Scenario: Command and Fix use ephemeral threads
- **WHEN** the user submits Command or Fix through a reuse-enabled bundled App
  Server workbench
- **THEN** the existing structured request runs once on a new ephemeral thread
  at the private empty cwd on the same process, receives no Ask preview or
  pointer privilege, and only the existing mode-specific parser may accept the
  final for review

#### Scenario: Mode switching keeps the prepared process
- **WHEN** the user switches among Ask, Command, and Fix while idle
- **THEN** no second process, thread, or turn starts and the prepared App Server
  remains available

#### Scenario: Reuse identity diverges
- **WHEN** new-chat intent is armed or the pointer, cwd, model, effort, engine,
  or thread settings differ from the idle session
- **THEN** the workbench reaps that session before starting or resuming through
  a new one

#### Scenario: Workbench closes with an idle session
- **WHEN** the workbench is destroyed after a successful reusable turn
- **THEN** it closes and reaps its private app-server child before exit

#### Scenario: Included context stays untrusted data
- **WHEN** a turn contains explicitly included captured output or a previous
  command
- **THEN** the adapter places only the bounded values in labeled untrusted-data
  blocks, never derives authoritative cwd from them, and treats embedded block
  delimiters or imperatives as data rather than instructions

#### Scenario: Streamed answer contains JSON or code
- **WHEN** an identity-correlated agent-message delta contains JSON, a fenced
  code block, a quoted key, split UTF-8, or coalesced prose
- **THEN** the recognized App Server path preserves the sanitized answer text
  without exposing raw protocol JSON or weakening another provider's filter

#### Scenario: Stream event has a foreign identity
- **WHEN** a delta, item, or terminal names another thread, turn, or item
- **THEN** it cannot become preview or final authority and the turn fails closed

#### Scenario: Unknown protocol activity appears
- **WHEN** app-server sends an unknown method, unknown item type, forbidden
  capability event, or a request ID the adapter did not originate
- **THEN** the adapter refuses any request, fails the turn closed, accepts no
  output, and changes no pointer

#### Scenario: Routine protocol activity surrounds the answer
- **WHEN** start/turn notifications, token or plan updates, or complete
  user-message, reasoning, plan, or context-compaction items accompany a turn
- **THEN** the adapter ignores their content, emits no raw protocol data, and
  continues selecting only final-answer or phase-unknown agent text

#### Scenario: Unexpected MCP startup stops acceptance
- **WHEN** any MCP startup notification appears before, during, or after a turn
- **THEN** the adapter refuses it, retires the process, accepts no result or
  pointer, and emits no configured-tools startup label

#### Scenario: Commentary precedes the final answer
- **WHEN** an agent-message item is marked `commentary`
- **THEN** its deltas and completed text never enter answer preview or final
  authority, and the adapter MAY emit only the fixed `Drafting the answer` note

#### Scenario: App-server answer exceeds the bound
- **WHEN** streamed text finishes with a final answer that fails the existing
  8192 UTF-8-byte or unsafe-character validation
- **THEN** it is classified as an invalid answer rather than unavailability,
  no final is accepted, and no pointer candidate commits

#### Scenario: App-server turn does not complete cleanly
- **WHEN** the protocol is malformed or oversized, an effective setting
  mismatches, the final item is missing, terminal status is not completed, a
  deadline expires, or the child exits abnormally
- **THEN** no final or pointer candidate is accepted and every selected child
  and request-local resource is reaped or removed

#### Scenario: Structured final is malformed after a clean seal
- **WHEN** a transport-sealed Ask, Command, or Fix final fails its existing
  mode-specific parser, size, safety, or deduplication check
- **THEN** only that result is rejected, no pointer or candidate authority is
  accepted, and the otherwise healthy prepared process remains available

#### Scenario: Ask pointer commit fails after a valid final
- **WHEN** a new Ask thread seals with a valid final but its request candidate
  cannot be validated or committed
- **THEN** no new pointer or answer authority is accepted, the prior pointer
  remains unchanged, and the shared process is retired

#### Scenario: Shared-process failure retires all local threads
- **WHEN** cancellation, timeout, failed turn, unknown/foreign protocol
  activity, actual MCP tool use, effective-policy mismatch, child exit, or
  stdout or stderr stream/drain failure occurs
- **THEN** no current result is accepted, the committed Ask pointer remains
  unchanged, request-local candidates are removed, and the private process and
  every local thread are retired without silent fallback

#### Scenario: Failure offers explicit compatibility recovery
- **WHEN** App Server cannot start or its turn stops on the safety boundary
- **THEN** the selected engine remains unchanged, prior answer and both pointers
  remain unchanged, no raw failure text is shown, and the fixed diagnosis says
  that Ctrl-X G opens the engine setting

#### Scenario: Cancellation cannot erase provider history
- **WHEN** the user cancels a submitted App Server turn
- **THEN** local preview, request candidate, and late output are discarded while
  the prior pointer remains unchanged, and the UI does not claim provider-owned
  history was erased; bounded process reaping MAY keep the cancellation state
  visible for up to three seconds

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

Doctor SHALL reuse the existing twelve-row inspector renderer and bounded
Up/Down selection plus Left/Right value windowing. Escape, the existing
clickable `Esc back`, or Ctrl-X D SHALL dismiss it. Ctrl-C MAY close the whole
workbench through existing teardown. Every other keyboard or pointer input,
including Enter, Shift-Enter, Tab, mode/provider/model/effort ranges, Actions,
Settings chords, editing, new chat, disclosure, wheel input, and sending paths,
SHALL be consumed or ignored without changing state. In ASCII mode selection
SHALL use `>` and horizontal overflow SHALL use `<` and `>`; Unicode glyphs and
color MAY reinforce meaning but SHALL NOT carry it. Doctor SHALL remain bounded
inside the existing twelve-row envelope without horizontal overflow at 80,
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
  preserved and the twelve-row promoted footprint does not shrink

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

### Requirement: Local provider setup
The workbench SHALL expose a provider-focused Setup presentation through the
existing Ctrl-X P chord, provider action, and top-rail provider range. Provider
Setup SHALL retain the existing Provider, Model, and Effort controls and their
immediate provider-scoped persistence semantics. Ctrl-X M, Ctrl-X R, and
Ctrl-X G SHALL open the typed palette on the matching field. Provider Setup SHALL
use the existing eight-row envelope and SHALL NOT add a standalone command,
first-run marker, dependency, provider, registry, settings schema, or frame
height.

When the exact bundled-default provider session has no selectable registered
provider, Ctrl-O SHALL still mount the workbench and SHALL open Provider Setup
automatically. The session SHALL retain its valid bundled adapter argv and
matching engine metadata while the prepared session records a null provider
identifier. This exception SHALL NOT apply to an empty configured provider
array or to any configured argv. A configured argv SHALL remain authoritative,
SHALL never cause automatic Setup entry merely because it resolves to no
registered identifier, and explicit Setup SHALL describe it only as
`configured externally` without displaying its argv or path.

Provider Setup SHALL show one inert CLI-availability status for each bundled
provider using the existing in-process PATH lookup. `AVAILABLE` SHALL mean only
that the registered CLI is an executable file on PATH at the time of the
snapshot. `UNAVAILABLE` SHALL mean that predicate was not satisfied. Setup
SHALL NOT execute a provider or adapter and SHALL NOT claim authentication,
entitlement, network, remote-model, protocol, transcript-store, or App Server
health. Its fixed prose SHALL use ASCII separators; color and Unicode MAY
reinforce focus but SHALL NOT carry status, selection, or navigation meaning.

When `provider_source === "default"` and the managed-default provider identifier
is null, Model and Effort SHALL be unfocusable, SHALL expose no pointer ranges,
and Left/Right SHALL write nothing. Configured provider sessions SHALL retain
Model and Effort editability. Selecting a provider SHALL address its exact
registered identifier, restore only that provider's valid saved model and
effort, and persist through the existing settings path. If the current provider
becomes unavailable, Setup SHALL show it as unavailable and SHALL NOT bracket or
select another provider implicitly.
Unavailable status rows SHALL be inert. Keyboard and pointer selection SHALL
produce the same provider, model, and effort outcomes.

Provider Setup SHALL be modal and non-sending. While it is visible the
workbench SHALL NOT start an inference turn, provider request, result write,
pointer mutation, or new provider/App Server preparation. A real selection
change MAY retire an incompatible prepared session, but dismissal SHALL wait
for that retirement and prepare at most the final current selection. Enter and
Escape SHALL both dismiss Setup without rolling back immediate selections.
With no provider change, dismissal SHALL preserve all mode and editor drafts,
conversation, candidates, context, result authority, Ask pointers, shell buffer,
and cursor. A real provider change SHALL clear only the previous provider's
conversation, candidate, and saved-chat display state, load only the new
provider's pointer for the current cwd, and preserve the user's drafts, context,
result authority, all pointer files, shell buffer, and cursor. Doctor SHALL
remain a separate action reached after dismissing Setup.

Typed-palette Provider leaves SHALL use the same capability state and complete
destination resolver as Provider Setup but SHALL not replace Setup or its
managed zero-provider recovery authority.

#### Scenario: User opens Provider Setup
- **WHEN** the user invokes Ctrl-X P, clicks the provider action, or clicks the
  top-rail provider range from an eligible workbench state
- **THEN** Provider Setup opens with Provider, Model, Effort, both bundled CLI
  statuses, and the local-only health disclaimer, without starting a provider
  process, thread, request, or turn

#### Scenario: Managed zero-provider state opens Setup
- **WHEN** the exact managed bundled-default session has neither bundled CLI
  selectable and the user presses Ctrl-O
- **THEN** the valid workbench session mounts directly into Provider Setup,
  identifies both CLIs as unavailable, and no request or preparation starts

#### Scenario: Configured provider remains authoritative
- **WHEN** a configured provider argv resolves to no registered identifier and
  the user opens the workbench or explicitly opens Provider Setup
- **THEN** the workbench does not auto-open Setup, explicit Setup says
  `configured externally`, provider selection is inert, and the argv or path is
  not displayed or replaced

#### Scenario: Managed-null controls are inert
- **WHEN** Provider Setup is open with `provider_source === "default"` and the
  managed-default provider identifier null
- **THEN** Model and Effort are unfocusable, have no pointer ranges, and no
  keyboard or pointer input can write a model or effort selection

#### Scenario: User selects an available provider
- **WHEN** the user selects a locally available provider by keyboard or pointer
- **THEN** that exact provider identifier becomes active, its valid saved model
  and effort are restored, the choice is persisted immediately, and no
  provider process or request starts

#### Scenario: Current provider disappears
- **WHEN** the active provider is no longer locally available while another
  provider remains available
- **THEN** Setup shows the current provider as unavailable and does not bracket,
  activate, or persist the other provider until the user selects it explicitly

#### Scenario: Setup dismisses safely
- **WHEN** the user presses Enter or Escape after zero or more Setup changes
- **THEN** immediate selections remain applied and incompatible preparation has
  retired before at most one preparation of the final selection begins. With
  no provider change, all unrelated draft, result, pointer, context, shell
  buffer, and cursor state is preserved; a provider change clears only the
  previous provider's conversation, candidates, and saved-chat display state
  while preserving those unrelated states and all pointer files

#### Scenario: Setup is legible without Unicode, color, or a mouse
- **WHEN** Provider Setup renders at 80, 100, or 140 columns with Unicode or
  color disabled and is operated by keyboard only
- **THEN** focus, selection, both availability states, health limits, and Back
  remain textual, the frame does not overflow, and the workflow remains
  complete

#### Scenario: Persisted selection survives a new invocation
- **WHEN** one workbench invocation selects and persists a provider and model,
  closes, and a second invocation opens with the same isolated state directory
- **THEN** the second invocation displays that provider and model before any
  interaction, and neither invocation has executed an inert provider canary

#### Scenario: Setup remains the recovery surface
- **WHEN** the user presses Ctrl-X P, selects the provider rail, or enters
  managed zero-provider recovery
- **THEN** Provider Setup opens with its existing authority and no typed-palette
  search or dynamic catalog state changes that authority

### Requirement: Raycast-style hierarchical settings palette

The Workbench SHALL expose one local palette with a closed view set of `root`,
`model`, `effort`, `provider`, `more`, and `engine`. Its actionable record
union SHALL remain exactly `[set]`, `[toggle]`, `[open]`, `[guard]`, and
`[n-a]`. Synthetic navigation parents SHALL be browse projections only; the
existing actionable leaf inventory SHALL remain the sole mutation authority.

Bare `Ctrl-K` and `Ctrl-X S` SHALL open an empty-query root containing exactly
these five parents, in order: `Set model`, `Set effort`, `Set provider`, `Initial choices`, and
`More settings & actions`. No setting leaf or model-effort permutation SHALL
appear at the empty root. `Ctrl-X M`, `Ctrl-X R`, and `Ctrl-X G` SHALL open the
corresponding child view directly with an empty query.

An empty child query SHALL browse all immediate logical children; five result
slots SHALL be only the painted window. A non-empty query from any view SHALL
search every eligible synthetic parent and actionable descendant. Managed
Claude and Codex SHALL be cross-switchable. Configured or opaque provider
authority SHALL remain contained to its shell-supplied models, efforts, and
eligible local actions. There SHALL be no provider-first model step, command
DSL, duplicated browse/search inventory, or model-effort Cartesian product.

Enter on a parent SHALL clear the query and drill down. Enter on a changed leaf
SHALL use the existing complete-destination mutation lifecycle. Enter on a
current Model leaf SHALL clear the query and drill into that model's Effort
view without persistence, retirement, preparation, provider switching, or
commit work. Enter on a current Effort leaf SHALL close the palette and restore
the Workbench without persistence, retirement, preparation, provider switching,
commit work, request, or send. Enter on any other current complete leaf SHALL be
a literal no-op. Successful Provider -> Model and Model -> Effort applications
SHALL retain their automatic child transitions. A successful Effort application
SHALL close the palette and restore the Workbench; Engine, Toggle, Open, and
Guard SHALL retain their owning surface behavior.

Escape SHALL remain the only cancellation/back navigation control: with a
non-empty query it clears the query and stays in the current view; with an empty
child it returns to root and focuses the first parent; with an empty root it
closes and restores the composer. `Ctrl-X P`, the provider rail, and managed
zero-provider recovery SHALL remain Provider Setup, and direct mode chords
SHALL retain their existing authority.

#### Scenario: Root is short and hierarchical

- **WHEN** the user opens the palette with bare Ctrl-K or Ctrl-X S and an empty
  query
- **THEN** exactly five parent rows appear — Set model, Set effort, Set
  provider, Initial choices, and More settings & actions — with no model, effort, provider,
  engine, or action leaf at root

#### Scenario: Child browsing is complete but painted in five slots

- **WHEN** the user opens Set model or another child view with an empty query
  and more than five eligible logical children exist
- **THEN** Up/Down traverses the complete logical set, the renderer paints at
  most five rows, and a sixth-or-later child remains keyboard and pointer
  reachable by the ordinary window

#### Scenario: Global search reaches hidden descendants

- **WHEN** the user types `lun` from root or any child view
- **THEN** the full eligible graph is searched and an exact provider-qualified
  Codex/Luna leaf may be selected without a provider/category/sigil step

#### Scenario: Escape is clear, back, then close

- **WHEN** the user presses Escape in a non-empty view, an empty child, or an
  empty root respectively
- **THEN** the query clears, the view backs to root, or the palette closes in
  that order, without a provider request

#### Scenario: Effort completion returns to the Workbench

- **WHEN** the user presses Enter on an already-current or changed Effort leaf
- **THEN** an already-current Effort closes immediately with no lifecycle work,
  while a changed Effort completes the existing apply lifecycle once and then
  closes, restoring the prior Workbench surface without a request or send

### Requirement: Shared capability catalog and Codex discovery

Provider capabilities SHALL be plain data shared by palette projection,
Provider Setup, provider switching, and mutation commit. A model capability
SHALL carry a safe `id`, request `model`, public `displayName`, bounded public
`description`, ordered model-specific `efforts`, `defaultEffort`, and
`isDefault`. Catalog source SHALL be `codex-model-list` or `explicit`; discovery
state SHALL be separate and limited to `loading`, `dynamic`, or `fallback`.

Managed Codex SHALL expose a validated explicit fallback immediately. On the
first palette open in an eligible Workbench invocation it SHALL start exactly one
asynchronous, invocation-local, initialization-only discovery attempt. The
attempt SHALL construct a new AppServerSession with no thread ID, use the
existing `ready()` and framing, call only a narrow `listModels(signal)` path,
and dispose on success, failure, cancellation, or timeout. It SHALL not use or
inspect the inference session and SHALL not start/resume a thread, start a
turn, infer, probe a model, scrape help, call `/v1/models`, persist a catalog,
start a daemon, add a service-tier setting, or add a dependency.

Initialization SHALL have a 10-second limit. All paginated model-list work
SHALL share one absolute additional 5-second budget. Each request SHALL use
`limit: 100` and `includeHidden: false`; no more than 10 pages or 1,000
entries SHALL be accepted. A cursor SHALL be null or a unique terminal-safe
string no larger than 4,096 UTF-8 bytes. Any timeout, process exit, repeated
cursor, malformed visible entry, oversized page, or cap breach SHALL reject
the entire dynamic catalog and leave fallback active.

Dynamic validation SHALL require unique `id` and `model` values, each 1–128
characters and valid under the existing `safeSetting` grammar. Display names
SHALL be non-empty, control/bidi-free, and at most 128 UTF-8 bytes;
descriptions SHALL be control/bidi-free and at most 512 bytes. Hidden entries
SHALL be defensively discarded. Efforts SHALL be non-empty, ordered,
deduplicated, and members of the shared Codex transport set
`minimal|low|medium|high|xhigh|max|ultra`. `defaultReasoningEffort` SHALL be
present in that model's efforts. The first usable server-order `isDefault`
model SHALL be the default, otherwise the first usable model SHALL be.

Dynamic success SHALL atomically replace, never union with, fallback. A valid
empty dynamic catalog SHALL replace fallback and be authoritative: Codex may
remain PATH-visible in Provider Setup/status, but it SHALL have no actionable
Provider or Model leaf without a complete destination. Catalog publication
SHALL increment the painted epoch, preserve focus only by stable identity, and
stage results until Applying ends.

#### Scenario: Discovery is initialization-only and bounded

- **WHEN** eligible managed Codex opens the palette for the first time
- **THEN** fallback rows are immediately actionable, one threadless transient
  session may call initialize and paginated model/list only, all pages share
  the stated limits, and no inference method or provider result occurs

#### Scenario: Dynamic data replaces fallback atomically

- **WHEN** every returned page validates, including a valid empty catalog
- **THEN** the complete dynamic catalog replaces fallback as one publication,
  no partial page is selectable, and an empty catalog contributes no Codex
  Provider or Model leaf

#### Scenario: Invalid discovery fails closed

- **WHEN** discovery times out, exits, repeats a cursor, exceeds a cap, or
  returns invalid/hidden data
- **THEN** no invalid or partial catalog is published, fallback remains
  actionable, and the invocation does not retry discovery

### Requirement: Provider, model, effort, and engine contract

Every `[set]` record SHALL resolve a complete `{authority, provider, model,
effort, engine}` destination before mutation. A provider leaf SHALL exist only
when a complete model and effort destination exists. Set Effort SHALL use the
current provider/model's advertised model-specific list; it SHALL not expose
efforts for every possible model.

The current execution tuple SHALL remain separate from selectable catalog data.
At managed-Codex startup, a persisted model passing the transport-safe grammar
and a persisted effort in `minimal|low|medium|high|xhigh|max|ultra` SHALL be
preserved even when absent from fallback. Such values remain executable and
current-but-unselectable until discovery advertises them. Discovery failure or
absence SHALL neither rewrite them, persist over them, nor block a request.
Switching away SHALL remove their selection path until later discovery
advertises them. Claude and configured providers SHALL retain explicit-list
membership validation.

Model effort resolution SHALL prefer: current supported effort, target
provider's persisted supported effort, model-advertised default, then first
advertised effort. Provider model resolution SHALL prefer: current usable
model, target provider's persisted usable model, first server-order advertised
default, then first usable model. A catalog-missing current model or effort
SHALL be status-only, SHALL leave Model usable for replacement, and SHALL leave
Effort with no selectable choices until a catalog-known model is chosen.

Codex App Server and Exec SHALL accept the same discovered effort transport set
through `max` and `ultra`; model capability still determines which of those
efforts is selectable. Claude SHALL use canonical request IDs
`claude-fable-5`, `claude-opus-5`, and `claude-sonnet-5`; only documented
`fable|opus|sonnet` override aliases SHALL normalize to those IDs. Claude's
explicit efforts SHALL be `low|medium|high|xhigh|max`, with no enumeration or
completeness claim.

#### Scenario: Current Codex tuple survives absent capability

- **WHEN** a persisted managed-Codex model or effort is transport-safe but is
  absent from fallback and live discovery
- **THEN** it remains the current executable tuple without being selectable,
  rewritten, persisted over, or treated as a request blocker

#### Scenario: Provider and effort leaves require complete destinations

- **WHEN** a provider has no catalog-known model/effort pair, including an
  authoritative empty Codex catalog
- **THEN** Provider Setup may report availability, but the palette exposes no
  actionable provider or model leaf for that provider

### Requirement: Universal record safety and public search

The record union SHALL remain exactly `[set]`, `[toggle]`, `[open]`, `[guard]`,
and `[n-a]`. `[set]` SHALL cover only advertised provider-qualified values,
managed Codex engines, and configured active advertised values. `[toggle]`
SHALL remain the captured-output inclusion toggle. `[open]` SHALL route only to
existing safe local surfaces. `[guard]` SHALL route/teach an existing
consequential surface without invoking its send, insert, save, discard, retry,
cancel, close, or reset callback. `[n-a]` SHALL be an explicit-query-only
fixed local refusal and inert on Enter.

Queries SHALL be invocation-local and bounded to 4,096 UTF-8 bytes. Existing
CR/LF/tab normalization, control/bidi filtering, NFKC-lowercased whitespace
terms, AND semantics, exact/prefix/substring/ordered-subsequence matching,
deterministic ranking, and public projections SHALL remain. Ranking quality
SHALL precede view/provider affinity. No private argv, path, prompt, secret,
raw protocol payload, unavailable value, freeform setting, history/favorites,
alias system, telemetry, natural-language parser, or generated tuple syntax
SHALL be added.

#### Scenario: Search and browse share authority

- **WHEN** the same invocation builds an empty child view or a non-empty query
- **THEN** both use the same current eligible catalog and leaf inventory, with
  no stale or private value becoming searchable or activatable

#### Scenario: Guard and refusal rows do not execute consequences

- **WHEN** the user focuses or activates a guard or refusal row
- **THEN** the guard only routes/teaches its owning surface and the refusal
  only explains its fixed reason; neither performs provider, result, insert,
  save, retry, cancel, close, or reset work

### Requirement: Six-row palette and identity-safe activation

The palette SHALL render exactly six semantic rows at supported 80, 100, and
140 column widths in Unicode and ASCII: one query/breadcrumb row and five
single-line result slots. No-match, no-usable-choice, blank, and refusal rows
SHALL be inert.

Transient progress, success, refusal, stale-selection, and failure feedback
SHALL use the bottom rail's left message slot. The lower-right bottom rail
SHALL contain only the applicable `Enter open`, `Enter apply`, `Enter effort`,
`Enter done`, `Enter keep`, or `Enter toggle`, followed by the exact `Esc clear`,
`Esc back`, or `Esc close` for the current query/view state. Applying SHALL
expose no actionable right-side instruction. The picker SHALL hide
captured-output disclosure and generic Ctrl-X help while open.

The query/breadcrumb row SHALL show the live Provider, Model, or Effort path
and the native query. The query SHALL take width priority over earlier
breadcrumb segments. The row SHALL NOT begin with a result-selection marker
or receive result-focus styling; breadcrumb separators elsewhere in the row
are permitted.

Each populated result row SHALL lead with one concise public choice label. It
SHALL follow that label with the derived parent intent for a non-empty global
descendant result, such as `Luna · Set model`. It MAY then show quiet provider,
textual `current`, or textual unavailability metadata when space permits.
Optional metadata SHALL disappear before the parent intent under width
pressure. Internal record kinds, engine identifiers, assignment syntax,
complete destinations or effects, and destination effort SHALL NOT compete
with the primary label or appear as bracketed tags.

Exactly one eligible focused result SHALL be painted as one
full-interior-width inverse span. That span SHALL contain no nested foreground,
background, or dim styling. Focus SHALL remain apparent without color, carry
identical meaning in Unicode and ASCII, and SHALL NOT use a leading caret or
selection glyph. Query, blank, and non-result rows SHALL NOT receive
result-focus styling.

At width pressure, the renderer SHALL preserve the primary result label,
focused-row treatment, derived parent intent, transient feedback, and required
controls. Optional result metadata SHALL be removed first. Text SHALL be
truncated by terminal-cell width using `…` in Unicode and `...` in ASCII. No
semantic row SHALL wrap or overflow.

This presentation correction SHALL NOT change candidate data, eligibility,
direct-match ordering, focus identity, pointer epochs, activation identity,
mutation paths, catalog behavior, or no-send guarantees. The only search
addition SHALL be public parent-intent fallback matching; direct matches SHALL
always rank before intent-only matches. Rendering and pointer revalidation
SHALL use the same five-slot window and exact footer boundary.

Keyboard activation SHALL reread and normalize the native query, rebuild live
sources, and exact-match stable identity. Pointer activation SHALL additionally
require the clicked slot to match the current painted query, source, and epoch.
Filtered position or a stale source index SHALL never be mutation authority.

#### Scenario: Painted stale clicks are inert

- **WHEN** a catalog publication, query edit, source rebuild, or epoch change
  occurs before a pointer click is handled
- **THEN** a stale painted row cannot focus or mutate a different destination

#### Scenario: Query and focused model have distinct hierarchy

- **WHEN** the global query is `sonnet` at 140 columns
- **THEN** the query row renders `Search All: sonnet` without a leading
  result-selection marker
- **AND** the focused result begins with the model choice before optional
  provider or current metadata
- **AND** exactly that result receives one full-interior-width inverse span
- **AND** `Set model` remains visible after the model choice at 80 columns
- **AND** no result row or footer instruction contains a bracketed
  internal-kind tag, complete tuple, effect, or `Already current`

#### Scenario: Narrow rendering preserves truth and controls

- **WHEN** the palette renders its longest existing public destination at 80
  columns in Unicode or ASCII
- **THEN** exactly six semantic rows render without wrapping or overflow
- **AND** optional metadata is removed before destination text is truncated
- **AND** state or action truth and required controls remain visible
- **AND** ASCII output contains only ASCII characters
- **AND** the following row remains readable after the focused row's inverse
  reset

#### Scenario: Presentation preserves activation identity

- **WHEN** focus moves, a populated label or existing padding target is
  clicked, a blank slot is clicked, or a previously painted row becomes stale
- **THEN** the pre-existing pointer outcome, selected record, epoch validation,
  and activation identity remain unchanged
- **AND** no settings mutation or send occurs merely from rendering or moving
  focus

### Requirement: Existing lifecycle, containment, and compatibility

Changed activation SHALL use the existing order: rebuild and exact-match,
resolve and compare the complete destination, route a current provider/model
Model leaf to Effort, complete a current Effort by closing without lifecycle
work, treat other complete-current leaves as literal no-ops, apply the unsaved
Engine guard, lock Applying, retire once,
capture the resulting generation after retirement invocation, await its barrier,
revalidate Workbench/epoch/generation/identity/catalog/destination, write the
whole provider-scoped document once only when the durable Provider/Model/Effort
tuple changes, commit coherently, clear the query, and perform the prescribed
post-apply transition. Same-provider Engine-only changes SHALL write zero
settings documents; cross-provider durable changes SHALL write one.

Retirement rejection, stale authority, or post-retirement disappearance SHALL
retain the old durable tuple, close with the existing public failure semantics,
latch requests and preparation closed, and perform no send or preparation.
Persistence-only failure SHALL retain the old durable tuple, apply the usable
in-memory choice, and report fixed not-saved copy without latching requests or
preparation closed. Unresolved local endpoint and missing or blocked local model selection
SHALL retain their own no-send guards. No preparation SHALL start while the
palette is open or Applying; successful idle Escape or changed-Effort completion
MAY permit at most one compatible preparation, while current-Effort completion
SHALL start none.

While open or Applying, query input, paste, navigation, Enter, Escape, pointer
input, Ctrl-X, and Ctrl+non-C continuations SHALL remain contained. Ctrl-C
SHALL retain teardown. The palette SHALL preserve drafts, cursor, captured
context, candidates, results, Ask conversation, saved-chat state, pointers,
shell buffer, Provider/Engine reset rules, direct chords, configured-provider
containment, and Ask History behavior. Provider Setup SHALL remain the
authority for availability, configured-external state, persistence, managed
zero-provider recovery, and dismissal.

#### Scenario: Applying is single-shot and fail-closed

- **WHEN** a changed leaf is activated and input or catalog state changes during
  retirement
- **THEN** only one mutation runs, final live identity is revalidated after the
  captured generation barrier, and stale/disappeared state causes no write,
  commit, request, or preparation

#### Scenario: Opening and discovery preserve workbench state

- **WHEN** the palette opens, discovers capabilities, changes catalog state, or
  closes without a changed selection
- **THEN** no provider request/result/turn/pointer starts, drafts/context/results/
  pointers/shell state remain intact, and only the existing final preparation
  rule can run after successful idle Escape

### Requirement: Managed loopback OpenAI-compatible provider

ShellQ SHALL offer one managed provider with identifier `local-openai`.
It SHALL use literal loopback HTTP only, explicit model discovery through
`GET /v1/models`, and `POST /v1/chat/completions` for Ask,
Command, and Fix. The provider SHALL be transport-managed: its selectability
depends on its bundled adapter file, never on a CLI binary or server health.
Ollama, Unsloth, and other local servers MAY be supported only when the same
byte-identical encoder and parser produce a usable result.

#### Scenario: Local provider is enumerated without health probing

- **WHEN** ShellQ enumerates providers
- **THEN** `local-openai` is selectable whenever its bundled adapter file is a
  regular executable, server health is not checked, no runtime is started, and
  no HTTP request is sent

#### Scenario: Main mount and Doctor are network-free; settings entry discovers bounded

- **WHEN** the workbench main surface is mounted or Doctor is opened
- **THEN** no local HTTP request, inference request, model probe, or runtime
  detection occurs, and no opening surface sends POST
- **WHEN** the settings palette, a model/effort palette view, or Provider Setup
  is entered while managed local is selectable and settings are valid
- **THEN** ShellQ automatically starts one bounded live discovery round: parallel
  `GET /v1/models` requests to the effective endpoint plus the fixed common
  literal loopback ports 1234, 8000, 8080, 8081, and 11434 — a fixed list, never
  a port scan — capped at eight validated literal loopback URLs with a
  one-second deadline, even while the managed Codex provider is active; a
  configured custom-provider invocation never probes. The
  round sends zero POST requests and its results are keyed by endpoint, so the
  same model ID advertised by two servers stays two distinct choices

#### Scenario: Only literal loopback bases are accepted

- **WHEN** a local endpoint is validated
- **THEN** only `http://127.0.0.1:<port>/v1` and
  `http://[::1]:<port>/v1`, each with an optional final slash and canonical
  decimal port 1–65535, are accepted

#### Scenario: Unsafe endpoint is rejected before traffic

- **WHEN** an endpoint uses HTTPS, a DNS name, `localhost`, another 127/8
  spelling, integer/hex/octal IPv4, mapped IPv6, a zone ID, userinfo,
  credentials, percent escapes, whitespace, dot segments, query, fragment,
  alternate path, omitted port, or ambiguous port
- **THEN** it is rejected as `INVALID_ENDPOINT` and receives zero traffic

#### Scenario: Explicit discovery is palette-triggered and GET-only

- **WHEN** the user activates the local model check from the settings palette
- **THEN** ShellQ runs the same bounded discovery round — `GET /v1/models` with
  only `Accept: application/json`, no body, credentials, cookies, proxy, retry,
  or redirect, to at most eight validated literal loopback URLs with a
  one-second deadline — and sends zero POST requests

#### Scenario: Catalog is strict and ordered

- **WHEN** a 200 catalog response has `{ "object": "list", "data": [...] }`
  with 0–512 entries
- **THEN** ShellQ preserves server order, admits only entries whose `id`
  matches the existing safe-model grammar, drops any non-conforming entry
  without failing the catalog, and treats an empty admitted list as `EMPTY`

#### Scenario: Unsafe catalog fails closed

- **WHEN** a catalog response has an invalid envelope, is oversized, is not
  valid JSON, or contains duplicate admitted IDs
- **THEN** the entire catalog is rejected as `CATALOG_MALFORMED` and no model
  becomes active

#### Scenario: Advertised model is not a usability claim

- **WHEN** an advertised model is unloadable, is not a chat model, or returns
  content that fails ShellQ validation
- **THEN** the failure is closed and scoped to that model, that model is
  blocked until a successful explicit valid catalog publication or endpoint
  change clears it; automatic refresh does not clear it, and every other
  catalog entry remains selectable

#### Scenario: Saved endpoint, model, and effort are restored immediately as selected preference

- **WHEN** a new invocation loads a syntactically valid saved local exact model ID
  and supported effort
- **THEN** the saved tuple is restored as selected preference immediately with
  the saved exact endpoint resolved before mounting, and explicit Submit may use
  it without opening the picker; requests target only that saved endpoint, and
  the adapter performs a fresh private GET preflight containing that exact ID
  before every POST

#### Scenario: Check does not choose an implicit first model

- **WHEN** an explicit check succeeds and no saved exact ID exists
- **THEN** no model is selected implicitly, no local provider leaf exists in
  the palette, and the user must choose an exact ID; when a saved exact ID does
  exist but is not in the advertised catalog or is blocked, the provisional
  provider row is preserved with its status accurately labeled

#### Scenario: Typed query reaches an exact local model

- **WHEN** a published catalog contains an exact advertised ID and the user
  types a distinctive substring of it
- **THEN** that exact record matches directly, ranks ahead of intent-only
  matches, and its activation target equals the raw catalog value

#### Scenario: Catalog publication and provider transitions preserve preference

- **WHEN** a catalog is published or the provider changes
- **THEN** the model/effort preference is preserved, composer is not reset, and
  endpoint-scoped snapshots are kept across provider switches; on endpoint change,
  ShellQ retains preference, clears endpoint-specific catalog/staging, pending
  discovery/application and request acceptance identities, and clears endpoint-specific
  blocks; explicit Submit thereafter targets the new endpoint and preflights

#### Scenario: Submission performs private preflight

- **WHEN** the user submits with an active local model
- **THEN** ShellQ sends one fresh private `GET /v1/models` and sends POST only
  if the exact active ID remains advertised; the private check does not replace
  the visible catalog

#### Scenario: Preflight proves freshness, not identity

- **WHEN** the preflight connection and the POST connection are separate
  connections, as the fresh-connection rule requires
- **THEN** ShellQ SHALL NOT claim the POST reached the same process that
  answered the preflight; the documented residual risk is that any same-user
  process able to bind the loopback port may receive the submitted payload and
  return a forged but schema-valid result, and the UI copy SHALL state that
  rather than implying only passive logging

#### Scenario: Model disappearance prevents inference

- **WHEN** the fresh preflight does not advertise the active exact ID
- **THEN** ShellQ retains preference, reports `MODEL_GONE`, writes no settings,
  preserves bad-output blocks, and sends zero POST requests; explicit Submit may
  preflight again without automatic prompt retry

### Requirement: Frozen local inference wire contract

The local adapter SHALL use one identical encoder and parser for every
compatible local server. It SHALL send exactly one Chat
Completions request after successful preflight, with the exact model ID, fixed
mode- and requested-count-specific system contract, canonical JSON user payload, `stream: true` for Ask and for Command/Fix
streamed previews (otherwise `stream: false`),
`n: 1`, `temperature: 0`, no output token cap, and strict JSON-schema
`response_format` named `shellq_ask_v1`, `shellq_command_v1`, or
`shellq_fix_v1`. Acceptance SHALL be decided by strict validation of the
returned content, never by the server's own framing claims.

#### Scenario: Canonical payload strips private authority

- **WHEN** ShellQ encodes a local request
- **THEN** Ask contains only the allowlisted query, environment, explicit
  captured output, untrusted marker, and optional bounded prior command;
  Command/Fix contain only their allowlisted command/status/environment/output
  fields, optional prior command, and optional avoided commands; PID, Herdr
  identity, sequence tokens, provider/session metadata, endpoint, credentials,
  and undefined keys are absent

#### Scenario: Ask schema is exact

- **WHEN** a local Ask completion is accepted
- **THEN** its content is an object with exactly `{ "answer": string }`, where
  the answer is non-empty, at most 8192 characters and bytes, and passes the
  existing control/bidi validator

#### Scenario: Command and nullable Fix schemas are exact

- **WHEN** a single-result local Command or Fix completion is accepted
- **THEN** it has exactly `tldr`, `corrected_command`, `confidence`, and `risk`;
  `tldr` is 1–500 characters, `corrected_command` is 1–8192 characters or
  null only for Fix, `confidence` is 0–1, and `risk` is 1–80 characters

#### Scenario: Strict response reconstruction

- **WHEN** a server returns extra envelope, choice, or content keys that do not
  belong to the selected ShellQ result
- **THEN** the adapter emits only a fresh allowlisted `{answer}` or four-key
  candidate object (inside the candidates envelope for a batch), never raw server JSON

#### Scenario: Content key set is exact

- **WHEN** completion content parses as an object whose required fields are all
  individually valid, but whose key set is not exactly the selected mode's key
  set
- **THEN** the result is rejected as `COMPLETION_MALFORMED`; an extra, unknown,
  or duplicate content key is never silently stripped, ignored, or forwarded

#### Scenario: Acceptance is reconstructed, never forwarded

- **WHEN** a local result is accepted
- **THEN** the adapter writes a freshly constructed object containing only the
  selected mode's allowlisted keys, copied field by field, and never emits the
  parsed server object itself

#### Scenario: Exhausted generation is refused in every mode

- **WHEN** a completion reports a `finish_reason` other than `stop`
- **THEN** Ask, Command, and Fix SHALL reject it as `COMPLETION_MALFORMED`,
  even when the content parses, because a syntactically complete response may
  still be semantically truncated

#### Scenario: Completion request has no output token cap

- **WHEN** the request is encoded
- **THEN** it contains no `max_tokens` or `max_completion_tokens` field, so
  private reasoning does not exhaust a client-imposed output token ceiling

#### Scenario: Clean empty completion is malformed

- **WHEN** a completion returns HTTP 200 with a fully framed empty or
  whitespace-only body, or a completed Ask stream with no content
- **THEN** the failure is `COMPLETION_MALFORMED`

#### Scenario: Prematurely closed completion remains a lost connection

- **WHEN** a completion response closes before its declared HTTP framing is
  complete
- **THEN** the failure is `CONNECTION_LOST` and remains manually retryable; the
  model is not blocked because the transport did not deliver a complete response

#### Scenario: Completion transport and final validation

- **WHEN** a completion response is processed
- **THEN** it must be HTTP 200 with exactly one choice, assistant string
  content, and absent or null tool/function calls, within 16 KiB of headers.
  Completion wire bytes SHALL NOT have a total size cap in Ask, Command, or Fix.
  Discovery retains its catalog bound. Connect, stall, absolute deadlines,
  cancellation, preview bounds, and strict final field validation remain.
  Ask SHALL parse SSE incrementally through complete HTTP framing, require
  choice index zero, a finish event and `[DONE]`, and reject conflicting roles,
  tool calls, invalid UTF-8, malformed events, and content after completion.
  Valid chunk extensions SHALL remain supported. Opted-in Command/Fix use the
  same SSE framing; unoffered direct calls remain final-only. Command/Fix require `finish_reason: "stop"`; retries, conversation IDs, and tools
  are not used

#### Scenario: Unvalidated structured-output hint is not a protocol failure

- **WHEN** a server accepts `response_format` without validating it, or returns
  content that ignores it
- **THEN** the content is parsed and validated unchanged with no prose, fence,
  or key-repair tolerance, a non-conforming result is `COMPLETION_MALFORMED`,
  and nothing returns the design to architecture review

#### Scenario: Divergent request field halts widening

- **WHEN** a later target cannot produce a usable result without a different
  request field or path
- **THEN** widening stops for that target only, already-proven targets are
  unaffected, and the encoder is never branched per runtime

#### Scenario: Batch uses one completion with strict member validation
- **WHEN** Command or Fix opts into `candidate_count: 3`
- **THEN** the adapter sends one completion POST with `n: 1` and a strict object schema containing a candidates array of one to three ordinary candidate objects
- **AND** the authored system contract asks for distinct useful approaches and learning explanations, without forwarding caller instructions as authority
- **AND** duplicate content keys at the envelope or any candidate depth, including escaped-key collisions, are rejected
- **AND** a non-`stop` finish reason rejects the entire batch, even when its JSON parses
- **AND** accepted candidates are reconstructed field by field after whole-batch validation

### Requirement: Local lifecycle, trust, and closed errors

The local HTTP client SHALL use direct literal sockets, verify the connected
remote address before HTTP writes, disable proxy and credential inheritance,
never follow redirects, create a new verified connection for each request, and
revalidate the endpoint immediately before POST. Failure classification SHALL
use only the HTTP status and the path it was observed on; server response
bodies SHALL never be parsed or surfaced.

#### Scenario: Redirect and non-loopback are not followed

- **WHEN** a server returns a redirect or a connection resolves to a
  non-loopback remote address
- **THEN** the request fails closed as `PROTOCOL_MISMATCH` or
  `ENDPOINT_UNAVAILABLE`, and no redirected or inference request occurs

#### Scenario: Adapter environment is allowlisted

- **WHEN** ShellQ spawns the local adapter
- **THEN** the adapter receives a freshly constructed environment containing
  only allowlisted keys and the explicit validated invocation endpoint snapshot
  for both discovery and inference; ambient changes cannot override it, no proxy
  or credential variable is inherited, and missing/empty/invalid adapter endpoint
  input fails INVALID_ENDPOINT/65 before any socket with no adapter default

#### Scenario: Unknown model on completion is model-gone

- **WHEN** the completion path returns 404 for the requested model on a base
  whose discovery path returned 200
- **THEN** the failure is `MODEL_GONE`, preference is retained, unavailable is
  reported, no settings are written, bad-output blocks are preserved, and the
  user is directed to check models again rather than told the protocol is wrong

#### Scenario: Response bodies never surface

- **WHEN** a local HTTP failure body contains model names, prompts, or other
  server content
- **THEN** that content reaches neither the UI, the failure detail, adapter
  stderr, nor any ordinary log

#### Scenario: Long generation is bounded by cancellation

- **WHEN** a completion takes minutes because the selected model is slow or
  cold
- **THEN** ShellQ surfaces a working state naming cancellation, keeps the
  request cancellable throughout, and applies only a generous absolute ceiling
  well above observed local generation times

#### Scenario: Cancellation leaves no authority

- **WHEN** Escape, Ctrl-C, provider change or teardown occurs during a check or
  inference, or an endpoint change occurs during pending discovery
- **THEN** every request/socket/adapter is aborted or reaped, discovery and
  inference lifecycles are tracked separately, one Escape cancels discovery and
  closes the picker in one stroke, and no result or pointer is accepted; busy
  inference prevents endpoint entry and endpoint mode guards both real request
  callers without a synthetic inference-overlap mutation

#### Scenario: Adapter termination is confirmed, not merely requested

- **WHEN** ShellQ cancels or tears down a local request whose adapter ignores or
  is slow to honour the first termination signal
- **THEN** the adapter shim replaces itself with the HTTP adapter process so no
  intermediate shell survives, the adapter traps hangup, interrupt, and
  terminate and closes its socket, and the parent escalates from a graceful
  signal to a forced kill after a bounded grace period and awaits actual exit
  before reporting the request finished

#### Scenario: Terminal hangup does not orphan a request

- **WHEN** the terminal delivers a hangup while a local completion is in flight
- **THEN** the adapter process and its socket are terminated rather than
  surviving to the completion ceiling, and no result is written anywhere

#### Scenario: Failures are fixed and redacted

- **WHEN** the local adapter or endpoint fails
- **THEN** ShellQ uses only the closed exit/message mapping for invalid request,
  invalid endpoint, unavailable endpoint, unsupported credentials, protocol
  mismatch, malformed catalog, gone model, rejected request, unsupported thinking
  control, rate limit,
  server failure, malformed completion, oversized response, timeout, lost
  connection, or cancellation; server bodies, headers, URLs, stderr, stacks,
  prompts, and responses never reach UI or ordinary logs; only deliberately
  opened endpoint configuration may display validated endpoint values or its
  private typed draft, never invalid loaded/env text

### Requirement: Local settings acceptance

Local settings SHALL retain version 2 and exact `{model, reasoning}` provider
entries, accepting `local-openai`, optional validated root `localEndpoint`, and optional
`localThinking` entries with exactly endpoint, model and enabled fields.
All endpoint parsing SHALL use one import-safe pure grammar with the existing
literal families, 1–65535 canonical decimal ports, input bound and optional
single trailing-slash normalization. Input SHALL NOT be trimmed or broadened.

#### Scenario: Local selection persists in the existing shape

- **WHEN** an exact local model is activated
- **THEN** its existing selection shape is saved and latest saved endpoint is
  preserved; no catalog, status, prompt, response, output, cwd, credentials,
  headers, raw error or transcript is written

#### Scenario: Endpoint persists before activation

- **WHEN** a valid endpoint is deliberately saved with no local model entry
- **THEN** only the optional root field is changed; reopening without an override
  resolves it, with no invented model, effort or provider activation

#### Scenario: Endpoint precedence is presence-based

- **WHEN** startup preparation resolves the endpoint using its supplied environment
  and original settings read before migration or an early return
- **THEN** a present valid override wins over saved and default and restricts
  automatic discovery to that one URL, an empty or invalid
  override blocks without fallback, and only missing or strictly valid settings
  without the field select `http://127.0.0.1:8000/v1`; the snapshot is invocation-only

#### Scenario: Invalid settings never substitute another server

- **WHEN** settings are malformed JSON, have unknown keys, wrong endpoint type,
  unsafe endpoint, excessive size, unsafe path or an operational read failure
- **THEN** local configuration stays unresolved absent a valid override or explicit
  applied endpoint; no default HTTP or ordinary replacement occurs, and non-local
  in-memory selections remain usable

#### Scenario: Endpoint editor is private and modal

- **WHEN** Configure local endpoint is opened from composer, a normal editor or
  candidate view
- **THEN** it suspends and restores the exact prior view/drafts, uses a separate
  endpoint draft, invalidates picker activation epoch, and never copies endpoint
  text into picker records/query/ranking, ordinary buffers or request artifacts
- **AND** Ctrl-X W and labeled Save save, Escape and labeled Discard discard,
  Ctrl-X R and labeled Reset explicitly reset; bare Enter never saves/submits;
  other navigation, rails, tabs, Setup, Doctor, include, new-chat, details and
  request callbacks are inert, while Ctrl-C tears down and discards

#### Scenario: Override makes configuration read-only

- **WHEN** the endpoint environment key is present, even empty or invalid
- **THEN** typing/save/reset cannot write shadowed settings; only validated values
  may be shown in the deliberate editor, invalid source text is never echoed,
  and fixed guidance requires removing the override before editing next invocation

#### Scenario: Invalid input and repair are distinct

- **WHEN** an endpoint draft is blank or invalid
- **THEN** save changes neither disk nor effective endpoint and leaves a fixed error
- **WHEN** the settings document is unresolved
- **THEN** the editor warns that unreadable selections cannot be preserved and
  requires a separate confirmation before replacing a malformed/oversized regular
  non-symlink file; Escape cancels confirmation and ordinary Enter does not save

#### Scenario: Safe repair rechecks latest state

- **WHEN** confirmed endpoint repair runs under the shared lock
- **THEN** it rechecks private parent and target, refuses symlink/directory/nonregular
  targets and access errors with fixed safe-path guidance, preserves latest valid
  selections if another writer repaired them, and never recursively removes data
- **AND** if an initially valid file becomes invalid, an unconfirmed write refuses
  replacement and requires the explicit warning/confirmation before retry

#### Scenario: Endpoint-only seed does not select local

- **WHEN** endpoint save/reset seeds missing settings or replaces confirmed invalid
  regular settings
- **THEN** providers is empty and the root provider is the effective registered
  provider; only an unregistered configured invocation uses the bundled default
  inert schema seed, without changing configured argv/source/scope or dispatch

#### Scenario: Reset and failures preserve invocation semantics

- **WHEN** reset is deliberately applied
- **THEN** it removes only localEndpoint from latest valid settings and uses the
  workbench default; confirmed invalid repair creates the endpoint-free seed
- **WHEN** valid save/reset cannot persist
- **THEN** the validated endpoint applies only to this invocation with fixed not-saved
  copy, subsequent model saves do not persist it, and reopen uses actual disk state
- **AND** an unchanged-value retry may persist without revoking valid authority;
  invalid-to-valid resolution is a change even when its string equals the default

#### Scenario: Concurrent writers preserve valid fields

- **WHEN** endpoint and provider/model/effort writers interleave in either order
- **THEN** one lock serializes re-read/merge/atomic replacement, preserving all
  latest valid unrelated fields, 4096-byte bound, 0700 directory and 0600 files;
  other processes' endpoint changes — including a direct hand edit of the same
  private `settings.json` — affect effective resolution at the next settings
  entry or next invocation, whichever comes first

#### Scenario: Older build sees an unreadable document

- **WHEN** an older exact-key build opens settings carrying a saved endpoint or
  naming local, regardless of current provider
- **THEN** it may reject and replace the document on its next write, losing saved
  endpoint/provider/model/effort selections but no prompt or other user content

#### Scenario: Cross-build write preservation is not guaranteed

- **WHEN** an older writer follows a schema-aware writer
- **THEN** endpoint and provider selections may be lost; preservation is promised
  only among schema-aware writers, without backup, sidecar or downgrade machinery

### Requirement: Local palette, Ask, and Doctor seam

The merged settings palette SHALL be the local model picker. Provider
Setup SHALL report the local provider as managed without gaining a new row.
The palette SHALL offer a value-free Configure local endpoint action regardless
of provider or adapter availability, subject to ordinary busy/Doctor exclusions;
configuration SHALL grant no provider, model or inference authority, and
automatic discovery SHALL remain catalog-only GET. Local Ask SHALL remain one-shot and prompt/context-only.
Doctor SHALL remain cached and network-free.

#### Scenario: Palette exposes exact catalog models and provisional saved preferences

- **WHEN** local models are rendered in the palette
- **THEN** admitted dynamic catalog entries enter the palette as exact model
  leaves, and syntactically valid saved/current exact tuples enter as provisional
  leaves labeled with their live state (`saved preference`, `unavailable`, or
  `blocked`); with no current dynamic catalog, the palette offers provisional
  saved preferences, configuration, and an explicit check where managed discovery
  is eligible

#### Scenario: Activation commits exact provider, model, and endpoint atomically

- **WHEN** the user activates a local model leaf — by keyboard or pointer click
- **THEN** the provider, exact model, and that leaf's exact endpoint commit as
  one atomic settings write guarded by the existing activation epoch, while
  background catalog publications and list refreshes preserve the selected
  preference without spurious abortion; the same model ID on two endpoints
  remains two distinct leaves whose activation targets carry their own
  endpoint, and submission goes only to the endpoint of the leaf chosen

#### Scenario: Managed-transport provider reports MANAGED

- **WHEN** Provider Setup renders provider availability
- **THEN** the row is generated from the registry, CLI providers report their
  existing available/unavailable tokens, the local provider reports a managed
  token, and the existing frame height is unchanged

#### Scenario: Local effort restores endpoint defaults

- **WHEN** the palette shows local effort
- **THEN** the only value is an endpoint-default label, it is never included in
  any request body, and selecting it removes the active endpoint/model thinking
  override without restarting or submitting a request

#### Scenario: Local Ask discloses its limits

- **WHEN** local Ask is idle or has returned an answer
- **THEN** its copy offers a local question and identifies completed local questions as independent, Details says
  `repository access: unavailable · prompt/context only`, and it reports
  `Ask history: one-shot; no pointer`; the answer is display-only and is never
  resent or persisted

#### Scenario: Doctor does not probe local state

- **WHEN** Doctor is opened
- **THEN** it reports only cached provider/settings/pointer rows, may say PASS,
  WARN, or FAIL from current local state, and never checks or displays the
  endpoint, catalog, raw model list, response body, or server health

#### Scenario: Doctor distinguishes effective endpoint blocking from persistence failure

- **WHEN** cached effective local endpoint configuration is unresolved
- **THEN** the settings row is FAIL for managed local dispatch, WARN for another
  active or configured provider, and uses fixed override-specific guidance when
  an invalid environment override prevents editing
- **WHEN** invalid disk settings are overridden by a valid explicit endpoint or
  an invocation-only endpoint remains after save failure
- **THEN** the settings row is WARN with `settings not saved; in-memory
  configuration active`, never endpoint FAIL or a claim of persistence; exactly
  four rows remain, no endpoint/port/raw value is shown, and no repair or HTTP occurs

#### Scenario: Never-auto-execute remains intact

- **WHEN** a local Command or Fix result is accepted
- **THEN** it is inserted only into `BUFFER` after final parent validation and
  is never executed; local Ask has no insertion or accepted-command path

### Requirement: In-flight reader navigation and reclamation
While an Ask, Command, or Fix preview is streaming, Up/Down, PageUp/PageDown, and wheel-over-reader
SHALL scroll without submitting a request or changing provider state. The reader
SHALL follow its tail until the user scrolls upward, retain the viewed sequence
across appends and prefix eviction when identifiable, and clamp to the oldest
retained text when the anchor is lost or ambiguous. Answer text SHALL remain
reachable when thoughts exceed the viewport, and a provisional channel label
SHALL remain visible. Escape SHALL still cancel and reap the active request.

#### Scenario: Closing after a sixteen-row peak
- **WHEN** the workbench closes after rendering sixteen rows
- **THEN** its receipt records the maximum effective height, zsh accepts that
  receipt, preserves preceding scrollback and the original buffer/cursor when
  no command is selected, executes nothing, and the next invocation starts at
  three rows

### Requirement: Compact candidate assessment and visual grouping
Command/Fix SHALL show the selected risk and `Confidence: N%` together above a
bounded scrollable explanation and a separate labeled Choices block. Labels stay
neutral; confidence values use green at >=90%, amber at >=70% and below 90%, and
red below 70%. Risk values independently use green Low, amber Medium, and red High.
Only an explicit leading risk assessment is classified; unknown prose stays
neutral with its original meaning retained. Edited assessments remain marked
not reassessed and use neutral values. Text remains understandable without color.
Explanations lead with outcome and scope before useful flag details and limitations.
The selected command uses a full-row highlight plus bold text and a textual marker.
The Choices block SHALL be anchored above the bottom frame rail. The explanation
uses the remaining height and scrolls only when its content overflows. The risk
reason appears once on its own line as `Impact: ...`. The Impact label uses the
same muted color as the Risk and Confidence labels; its consequence retains normal
foreground contrast. A blank line separates the
assessment from the explanation; the risk label is not repeated. During candidate selection, the action rail
shows insertion and Actions, without thinking or attachment hints. Those request
controls remain available through Actions.

#### Scenario: High confidence cannot hide high risk
- **WHEN** a candidate reports confidence 0.9 and High risk
- **THEN** `Confidence: 90%` is green and `Risk: High` is independently red
- **AND** clicking the assessment opens its confidence explanation in Details;
  Ctrl-X H provides the same information without a mouse
- **AND** confidence is described as a provider estimate, not a measured success
  rate or safety check; selection and insertion authority remain unchanged

### Requirement: Global initial choice count
Settings SHALL offer Initial choices from 1 through 5, defaulting to 3, persisted
in global settings. It applies to the next initial managed Command/Fix request.
Ask and configured custom providers retain their single-result behavior. Another
suggestion requests one more candidate up to the existing total limit of five.
All managed provider boundaries SHALL validate integer counts 1–5, with omitted
count meaning one; Ask permits only one. Batch validation remains atomic and may
return fewer useful candidates rather than padding.

#### Scenario: A saved count survives reopening
- **WHEN** the user saves five initial choices and reopens ShellQ
- **THEN** the next managed Command/Fix request asks for up to five candidates
- **AND** changing this setting does not send a request or alter existing candidates
- **AND** a failed settings write does not apply or claim a saved preference

### Requirement: Compact Command and Fix previews
Command/Fix streaming previews SHALL grow up to 12 rows, capped by available
terminal height, while retaining their scrolling content. Finished candidates
may grow up to 16 rows when their content needs it. Native frame height remains
monotonic; Ask streaming retains its existing 16-row ceiling.

#### Scenario: Long previews finish with compact choices
- **WHEN** Command/Fix streams more than twelve rows of preview text
- **THEN** the preview scrolls within twelve rows instead of promoting to sixteen
- **AND** a final result may promote to sixteen when needed for its content
