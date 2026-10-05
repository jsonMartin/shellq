# 0002: Managed local OpenAI-compatible provider

## Status

Accepted

## Context

ShellQ reaches bundled inference through provider-specific command adapters
(Codex, Claude). A user who already runs their own local OpenAI-compatible
chat server had no way to select that server as one managed ShellQ provider,
discover its models safely, or use the existing Ask/Command/Fix review
boundary without adding provider-specific logic to zsh. SQ-13 (see
`openspec/changes/add-shellq-local-openai-endpoint/`) adds one deliberately
narrow `local-openai` provider. Its first proving target is one
already-installed local OpenAI-compatible server; support widens to other
local servers only once the unchanged encoder and parser prove out against
them (see `design.md`, "Widening").

Before implementation, this change ran read-only measurements against that
live target instead of relying solely on the original frozen design
estimates (`proposal.md`, "Measured constraints"). Several of those
measurements contradicted the original estimates and forced the decisions
below. Each decision here states the measurement that forced it. Model
identity, endpoint, and port are intentionally omitted below; only size class
and observed behavior are load-bearing.

## Decision

### One managed direct Chat Completions adapter

We chose one ShellQ-managed, one-shot HTTP adapter speaking a frozen subset
of the OpenAI Chat Completions protocol directly, rather than a harness, a
Responses adapter, or per-runtime adapters. See "Alternatives considered" for
the rejected options and reasons; this option was chosen because it fits the
existing one-shot JSON boundary and keeps transport, lifecycle, and
redaction control inside ShellQ rather than inside a general-purpose
harness process tree.

### Acceptance is decided by strict content validation, not server framing

Discovery and the completion path were observed to disagree about the usable
model set: an advertised model returned HTTP 200 with a clean, complete
envelope while merely echoing the request back as if it were a chat
response — a non-chat model satisfying every envelope check. Envelope
validity (status, shape, single choice, string content) is therefore
necessary but not sufficient. Acceptance is decided by strict validation of
the parsed content against the mode's exact schema, never by the server's
own claim that the request succeeded.

### Exact content key-set check

The shared response validator (`responseIsValid` / `parseProviderResponse` in
`src/workbench.ts`) validates each required Command/Fix field
individually but does not constrain the key set, and returns the parsed
object verbatim. Executing it against a constructed object carrying one
extra key (`{tldr, corrected_command, confidence, risk, injected}`)
confirmed by execution, not inspection, that the extra key is accepted and
forwarded. The local adapter therefore requires the parsed content key set to
equal the mode's expected key set exactly, and always emits a freshly
constructed allowlisted object copied field by field rather than the parsed
object. This is a gap in the shared validator, not merely an extra local
check; tightening the shared validator for every provider is out of scope
here because it could reject output that existing providers already return.

### Finish reason handled per mode

A complete, semantically correct answer was observed reporting
`finish_reason: "length"` because private reasoning consumed most of the
token budget before the visible answer was produced (a 148-character valid
answer consumed 512 completion tokens in one measurement). Treating any
non-`stop` finish reason as fatal would reject good results; ignoring finish
reason entirely would let a syntactically complete but semantically
truncated command reach the shell buffer. The adapter budgets `max_tokens`
well above the observed reasoning cost so a conforming answer normally
finishes with `stop`, and then applies finish reason per mode: Command and
Fix reject any non-`stop` finish reason as malformed, because their output
reaches `BUFFER`; Ask, which is display-only, may accept a validated answer
at any finish reason.

### Independent private endpoint configuration

One optional root `localEndpoint` persists before model activation, leaving
provider selection entries unchanged. A value-free palette action opens the
existing editor in a private modal mode. Configuration is available even for
configured providers and unavailable adapters; it grants no dispatch authority.
Environment presence overrides saved configuration and locks editing, including
invalid overrides. Only missing or strictly valid endpoint-free settings use the
workbench default. One pure grammar serves resolution and transport; adapters
require explicit validated snapshots and have no default.

Ordinary writes refuse invalid/unreadable documents to prevent silent server
substitution. Explicit editor confirmation may repair invalid regular files
under the shared safe lock, preserving latest valid fields; unsafe paths/access
remain filesystem repair. Save failure retains labeled invocation-only state.
Private storage/editor display is intentional, not a secret vault; endpoint
values never enter search, ordinary buffers, Doctor or request/session artifacts.
Endpoint-only seeds contain no model entries, using the effective registered
provider or an inert bundled-default root for configured custom dispatch.

### No settings version bump

Widening the settings document to accept `local-openai` as a provider value
and the optional root endpoint does not bump the settings schema version.
An endpoint-bearing document is rejected by older exact-key readers even when
its current provider is not local; endpoint/provider/model/effort settings can
all be lost on their next write. An older ShellQ build already
treats an unrecognized provider id as invalid and overwrites the document
with in-memory defaults on its next write; it would do exactly the same to
an unrecognized version number. A version bump would not have prevented the
loss it is meant to signal, so the change accepts the loss and states it
directly (see the README's settings-downgrade note and `design.md`,
"Settings") rather than adding migration machinery that would not change the
outcome.

### Deadlines split into connect, stall, and absolute bounds

Measurement showed one absolute deadline cannot serve both request shapes.
Discovery answered in about 0.13 seconds, so a short deadline for it is safe.
Completion latency is dominated by model choice and was measured between
roughly 62 seconds and roughly 336 seconds for the same request against
different model sizes on an idle, warm server — a single short absolute
completion deadline (originally 180 seconds) would fail on ordinary success.
Completion is therefore bounded by three separate constants: a connect
deadline, a stall deadline measuring received-byte silence, and an absolute wall-clock ceiling as a
backstop for an unattended request. Discovery and the completion preflight
keep one short combined connect/absolute deadline, since they are already
fast and are not the deadline that measurement falsified.

The 120-second stall bound cannot observe internal generation progress. A
buffered generation may time out while the model is still working; a byte
trickle is bounded by the 900-second absolute ceiling. Later observations under
swap pressure were Command success at 662,944 ms, Ask success at 166,670 ms, and
nullable Fix exit 76 at 900 seconds. These observations do not establish decode
speed, byte cadence, or current deadline headroom. The frozen constants remain
unchanged, and the failed live Fix acceptance remains open.

### Structured-output hint kept but never trusted

Measurement showed a well-formed `response_format` JSON-schema hint was
honored and produced exact schema-conforming content — so it is worth
sending. It also showed a syntactically invalid `response_format` was
accepted with HTTP 200 rather than rejected — so the hint cannot be treated
as an enforced contract. The adapter keeps sending `response_format` and
also restates the schema in prose inside the system contract, but the only
enforcement is the adapter's own strict parse-and-validate step on whatever
content actually comes back; a server ignoring or mishandling the hint is
not treated as a protocol failure, only as ordinary content that must still
pass validation.

### No allowlist or denylist for non-chat catalog entries

Discovery advertised an entry the completion path did not usably support:
it returned HTTP 200 and echoed the request while satisfying every envelope
check, i.e. a non-chat model reachable through the same catalog. Rather than
maintaining a curated allowlist or denylist of "known-chat" model IDs, which
would need updating for every new server and every new model, the adapter
fails closed on first use: a model whose completion fails validation is
blocked for the current endpoint until a successful explicit catalog refresh
or endpoint change, and every other catalog entry remains selectable. Automatic
picker refresh preserves these blocks. This allows deliberate recovery without
a curated model list or an automatic retry of invalid output.

### Saved selection and asynchronous discovery

The approved fast-selection amendment restores a valid saved exact model and
supported effort as preference immediately. The unchanged private preflight
must find that exact ID before POST; a picker catalog is display data, not a
prerequisite for submitting the saved choice. The tuple applies to the effective
endpoint, including a valid override, without a settings schema change.

Eligible provider/model picker openings refresh the configured endpoint once
per completed automatic attempt per invocation. Cancellation leaves that attempt
retryable. Discovery owns its child and retirement separately from inference so
switching to Codex never waits for local shutdown. Refresh and provider switches
retain the preference and catalog snapshot; endpoint changes invalidate the
snapshot and pending operations. No server scanning or implicit model choice is
introduced. Setup, Doctor, and workbench opening remain network-free.

## Consequences

- The local adapter is the only ShellQ component that speaks HTTP, and it
  owns the entire loopback trust boundary itself (verified-peer-before-write
  sockets, no proxy/credential inheritance, no redirects, fresh connection
  per request) rather than delegating to a general HTTP client or harness.
- Content validation, not server framing, is the actual acceptance boundary,
  so every future local target must be re-checked against the same strict
  validators; a server that returns friendlier envelopes does not get an
  easier path.
- The shared Command/Fix response validator's missing key-set check remains
  unfixed for every other provider; only the local adapter compensates for
  it internally. Any future provider built on top of the same shared
  validator inherits the same gap until it is fixed once, centrally.
- An older ShellQ build that opens a settings document naming the local
  provider or carrying a saved endpoint, regardless of active provider, can
  discard endpoint/provider/model/effort selections on its next write.
  This is documented, accepted, and reselectable — no prompt, output, or
  other user content is stored in that document to lose.
- The completion path's 900-second ceiling was roughly 2.7x the historical
  336-second success. Loaded-machine evidence above does not establish that
  margin today; cancellation remains the interactive escape hatch.
- ShellQ's redaction does not control what the separately operated server
  records in its own logs, including submitted prompts and generated content.
- A transient server hiccup (e.g., a restart mid-request returning HTTP 200
  with an empty body) is classified as retryable and does not blacklist the
  model, while a request that returns well-formed-but-wrong content is
  treated as a real, endpoint-scoped failure requiring explicit recovery. Getting this distinction
  wrong in either direction would either permanently blacklist a good model
  on a transient hiccup or silently retry a genuinely broken one forever.

## Alternatives considered

| Option | Result | Reason |
| --- | --- | --- |
| Managed direct Chat Completions adapter | **Chosen** | Fits the existing one-shot JSON boundary; gives exact transport, lifecycle, and redaction control inside ShellQ. |
| Codex App Server custom provider | Rejected | Carries configured helper/MCP startup and a large prepared process tree that a narrow local-completion feature does not need. |
| Direct Responses adapter | Rejected | Adds state, streaming, and version surface that a one-shot flow has no use for. |
| Separate per-runtime adapters | Rejected | Duplicates protocol, trust, lifecycle, and error-handling logic across runtimes instead of proving one encoder/parser first. |
| Existing arbitrary `SHELLQ_PROVIDER` escape hatch | Rejected as the managed feature | Cannot provide managed discovery, Provider Setup, Doctor, persistence, or a palette seam; its existing (unmanaged) behavior is left unchanged. |
| Pre-SQ-12 temporary model picker | Rejected / obsolete | Was a stopgap before the fuzzy settings palette (SQ-12) merged. Once the merged palette became the one model authority for every provider, a separate temporary local picker would have duplicated filtering, navigation, and activation instead of reusing the existing implementation. |
| Holding one connection across preflight and POST | Rejected | Contradicts the fresh-connection-per-request rule that keeps the trust boundary simple and auditable. It also would not have closed the interception risk it might appear to close: any same-user process able to bind the loopback port in between can already read this user's files, so pinning the connection buys negligible additional trust at the cost of a more complex, longer-lived socket lifecycle. |

## Related

- `openspec/changes/add-shellq-local-openai-endpoint/proposal.md` —
  "Measured constraints" table (the evidence cited throughout this ADR).
- `openspec/changes/add-shellq-local-openai-endpoint/design.md` — full wire
  contract, deadlines table, and classification table.
- `openspec/changes/add-shellq-local-openai-endpoint/specs/shellq/spec.md` —
  the durable observable-behavior requirements this decision implements.
- `src/local-openai-provider.ts` — the reference implementation of
  the decisions recorded here.


## Ask streaming amendment (2026-09-12)

Ask now uses streaming Chat Completions over the same verified loopback socket.
Only answer content and optional model-provided thinking enter the provisional
UI; finish/DONE/framing and strict final validation establish acceptance.
Command/Fix remain non-streaming with stop validation. At the user's explicit
request, all three modes omit a total completion wire-byte cap: normal Qwen SSE
metadata exceeded the former 128 KiB bound. Header/catalog, preview/final field,
deadline and cancellation boundaries remain. Historical measurements above
still describe their original non-streaming requests.
