## ADDED Requirements

### Requirement: Ask history index
The plugin SHALL maintain one append-only local index of Ask conversations in
its private state root, written with file permissions `0600` inside the `0700`
root. Each record SHALL hold locators only: a format version, the provider
identifier, the provider session identifier, the trusted cwd the conversation
ran in, the conversation's first timestamp, and a storage class naming where its
content lives. A record SHALL NOT contain a question, an answer, a preview, a
turn, provider reasoning, tool calls, tool output, or captured or pasted output
bytes.

A record SHALL be appended only after the conversation's session pointer has
been committed, as one whole line per append so that concurrent invocations
cannot interleave a partial record. The index SHALL NOT be rewritten,
compacted, or reordered.

On read the index SHALL be treated as untrusted input: it SHALL reject a
symlink, a non-regular file, or a file exceeding a fixed byte bound, and SHALL
skip any malformed, unversioned, or unknown-shaped record without failing the
read. The absence, loss, or unreadability of the index SHALL never fail an Ask
turn, block the workbench, or start a provider call.

#### Scenario: A successful conversation is indexed
- **WHEN** an Ask conversation's session pointer is committed
- **THEN** one locator record for it is appended to the index, carrying no
  question, answer, or turn text

#### Scenario: Concurrent appends do not interleave
- **WHEN** two workbench invocations index a conversation at the same moment
- **THEN** both records are readable and neither is truncated or interleaved
  with the other

#### Scenario: An unreadable index degrades quietly
- **WHEN** the index is a symlink, is not a regular file, exceeds its byte
  bound, or contains malformed records
- **THEN** the affected records are skipped or the index is treated as empty,
  the Ask turn still succeeds, and no provider call starts

#### Scenario: A failed turn is not indexed
- **WHEN** an Ask turn fails, is cancelled, or produces no committed pointer
- **THEN** no record is appended for it

### Requirement: Ask history browser
The workbench SHALL provide a history browser opened only by an explicit
`Ctrl-X B`. It SHALL NOT open by itself, SHALL NOT open when the workbench opens
or when modes change, and SHALL NOT start a provider call for any reason,
including displaying a conversation.

The browser SHALL present one list of indexed conversations across every cwd and
every provider, most recent first, within the eight-row promoted envelope, each
row identifying the conversation's provider, cwd, and date without relying on
color or Unicode. Selecting a conversation SHALL open a bounded scrollable
reader for that conversation only, and its content SHALL be read at that point
rather than when the list is built.

Conversation content SHALL be read in process from the provider's own store and
SHALL be treated as untrusted input: bounded on read, rejected when the file is
a symlink or not a regular file, and revalidated against the same predicates a
live Ask answer must pass before being displayed. The browser SHALL present
questions and answers only, and SHALL NOT present provider reasoning, tool
calls, tool output, or captured or pasted output bytes.

The browser SHALL state the limits of what it shows: one caveat per conversation
that displayed turns are reconstructed from the provider's store rather than
recorded by the workbench, and one marker per turn that began with no
recoverable answer. A conversation whose question cannot be recovered SHALL be
shown with that turn marked as a gap rather than being treated as an error or
omitted. The browser SHALL show, per provider, one coverage line stating how
many conversations it holds and what it cannot account for.

Nothing in the browser SHALL be insertable, extractable, acceptable, or
executable, no browsed conversation SHALL be resumed or replayed, and the shell
edit buffer SHALL remain unchanged. The browser SHALL be fully operable from the
keyboard.

#### Scenario: Browser opens only on request
- **WHEN** the workbench opens, changes mode, or completes an Ask turn
- **THEN** the history browser does not open, and no conversation content is
  read

#### Scenario: Conversations across every directory are listed
- **WHEN** the user presses `Ctrl-X B`
- **THEN** indexed conversations from every cwd and every provider are listed
  most recent first within the eight-row envelope, and no provider call starts

#### Scenario: Content is read only when a conversation is selected
- **WHEN** the list is displayed and no conversation has been selected
- **THEN** no provider store has been opened for content, and selecting one
  reads only that conversation

#### Scenario: A conversation's content is unreadable
- **WHEN** a selected conversation's transcript is missing, oversized,
  malformed, a symlink, or fails revalidation
- **THEN** the browser states that its content is unavailable, keeps the rest of
  the list usable, and starts no provider call

#### Scenario: An unrecoverable turn is marked, not hidden
- **WHEN** a conversation contains a turn that began with no recoverable answer,
  or whose question cannot be recovered
- **THEN** that turn is shown with a gap marker rather than being omitted or
  treated as an error

#### Scenario: Coverage is stated per provider
- **WHEN** the browser is open
- **THEN** each provider has one line stating how many conversations it holds
  and what it cannot account for, legible without color or Unicode

#### Scenario: History offers no command or resume path
- **WHEN** a browsed conversation is displayed
- **THEN** no extraction, acceptance, execution, insertion, resume, or replay
  action is offered, and the shell edit buffer is unchanged

#### Scenario: Browser is unavailable while busy
- **WHEN** a provider request is active
- **THEN** `Ctrl-X B` does not open the browser

### Requirement: Retroactive Ask history discovery
The plugin SHALL discover Ask conversations that predate the index only on an
explicit user action, never on open, on mode change, or on a schedule. The scan
SHALL be cancellable, and conversations already discovered when it is cancelled
SHALL be kept.

A conversation SHALL be attributed to shellq only by provenance the provider
itself recorded plus a structural signature of the request — its version, its
`mode: "ask"`, and the shape of its query field. Instruction text SHALL NOT be
matched, because it has drifted between shellq versions. The cwd of a candidate
and the text of its turns SHALL NOT be used to decide whether it belongs to
shellq. A provider whose store records no such provenance SHALL have its
conversations marked indexed-only, and the browser SHALL state that earlier
conversations for it cannot be identified.

Extraction SHALL tolerate the shapes a provider store actually contains rather
than one assumed shape; a record whose payload is a string in some entries and a
list in others SHALL be read correctly in both forms, and fixtures SHALL pin
both. A conversation that a signature cannot confirm SHALL be left out rather
than guessed at, and discovery SHALL NOT modify, move, or delete anything in a
provider's store.

#### Scenario: Discovery runs only when asked
- **WHEN** the workbench opens, changes mode, or opens the browser
- **THEN** no retroactive scan starts

#### Scenario: Cancelled discovery keeps what it found
- **WHEN** the user cancels a running scan
- **THEN** the conversations already discovered remain indexed and the scan does
  not resume by itself

#### Scenario: Provenance decides attribution, not text
- **WHEN** a stored conversation discusses shellq but carries no shellq
  provenance and no matching request signature
- **THEN** it is not indexed, regardless of its cwd or its content

#### Scenario: A provider without provenance is labelled
- **WHEN** a provider's store records no originator for its conversations
- **THEN** its conversations are marked indexed-only and the browser states that
  earlier conversations for it cannot be identified

#### Scenario: Both payload shapes extract
- **WHEN** a provider store records a tool output payload as a string in some
  entries and as a list in others
- **THEN** both are read correctly and neither shape is silently skipped

#### Scenario: Discovery never writes to a provider store
- **WHEN** a retroactive scan runs
- **THEN** nothing in any provider's store is modified, moved, or deleted, and
  no provider process starts

## MODIFIED Requirements

### Requirement: Resumable Ask conversations
The bundled adapters SHALL persist only successful Ask conversations, SHALL
resume only an exact validated provider session ID associated with the same
trusted cwd, and SHALL leave Command and Fix requests ephemeral. The workbench
SHALL store no provider transcript and SHALL make no provider call merely to
discover or display resumable state. Reading a provider's own store in process,
after an explicit user action, is not a provider call for the purpose of that
prohibition; it starts no provider process and SHALL NOT be performed merely to
open the workbench, switch modes, or display resumable state. The private state
root MAY also hold one global inference-settings file and one Ask history index
as siblings of the per-cwd pointer directory; the settings file carries no cwd,
session, or provider-transcript data and is governed entirely by the
Session-scoped inference controls requirement, and the history index carries
locators only and is governed entirely by the Ask history index requirement,
never by this one.

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

#### Scenario: Opening the workbench reads no history
- **WHEN** the workbench opens or the user switches modes
- **THEN** no provider store is opened, no history index record is read for
  display

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

The Ask history browser and its reader SHALL request an eight-row envelope
without reducing an already larger invocation footprint.

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

#### Scenario: History preserves the promoted footprint
- **WHEN** the Ask history browser or its reader opens
- **THEN** it requests eight rows and retains any larger existing footprint
  without shrinking the invocation

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
- **WHEN** the user leaves a review, editor, details, Doctor, Provider Setup, typed palette, history, or help
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

### Requirement: Ctrl-first interaction grammar
Ctrl-O SHALL open the universal workbench. Custom workbench accelerators SHALL
use a Ctrl-X prefix, while standard Tab, Shift-Tab, Enter, arrow, Escape, and
Ctrl-C behavior SHALL remain available. Ctrl-X P SHALL open Provider Setup.
Ctrl-X S and in-Workbench Ctrl-K SHALL open the typed palette root; Ctrl-X M,
Ctrl-X R, and Ctrl-X G SHALL open its model, effort, and engine child views.
Ctrl-X P SHALL remain reachable by its chord, by the top border's provider
range, and by name on the actions surface's header row, and SHALL NOT occupy an
actions-surface grid cell. Ctrl-X B SHALL open the Ask history browser; arrow
keys, PageUp, PageDown, Enter, and Escape acquire their browser meanings while it
is open. Escape returns to the primary interaction rather than closing the
workbench. Optional pointer input MAY provide an additive
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
  alternative, save, provider, history, or new-chat action occurs without submitting
  implicitly

#### Scenario: History browser is keyboard-complete
- **WHEN** the history browser is open
- **THEN** every browser action — moving the selection, opening a conversation,
  scrolling its reader, and returning to the primary interaction — is available
  from the keyboard alone

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
