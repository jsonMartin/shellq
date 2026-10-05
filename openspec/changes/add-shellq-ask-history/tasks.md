# Tasks — Ask history browser

Depends on `add-shellq-multi-provider`. Each phase is independently testable.
Phase 2 is the thinnest end-to-end slice: browse one real conversation.

## Phase 1 — Index

- [ ] `history.jsonl` in the private state root, `0600` inside the `0700` root;
      one whole-line `O_APPEND` write per record
- [ ] Record shape `{v, provider, session_id, cwd, first_ts, storage}` and
      nothing else
- [ ] Append only after the session pointer commits; nothing appended for a
      failed, cancelled, or uncommitted turn
- [ ] Untrusted read: symlink, non-regular, oversized rejected; malformed or
      unknown-shaped records skipped, never fatal

**Automated:** `bun test` — a committed turn appends exactly one locator record
carrying no turn text; a failed turn appends none; concurrent appends both land
whole; hostile and malformed index files degrade without failing an Ask turn.

## Phase 2 — Slice: browser over indexed conversations

- [ ] `Ctrl-X B` opens the browser; never opens implicitly; unavailable while a
      request is active
- [ ] List across every cwd and provider, most recent first, in the eight-row
      envelope; provider, cwd, and date legible without color or Unicode
- [ ] Lazy reader: content read on selection, not on list build
- [ ] Codex extractor — question and answer only; tolerates
      `function_call_output.output` as **both** a string and a list; missing
      query is a gap marker
- [ ] Untrusted read of provider stores: bounded, symlink and non-regular
      rejected, revalidated against the live-answer predicates
- [ ] No insert, extract, accept, execute, resume, or replay path
- [ ] Actions sheet: `B history` takes the `Esc close` cell; `PgUp/PgDn scroll`
      hint moves to the header row

**Automated:** `bun test` — opening the workbench and switching modes read no
provider store; building the list opens no transcript; fixtures pin both payload
shapes; a missing, oversized, malformed, or symlinked transcript yields
"unavailable" with the rest of the list usable; no provider process starts on
any browser path.

**Human:** Ctrl-O → `Ctrl-X B` → conversations appear with correct cwd and
dates; open the 9- and 11-turn chats and scroll; Escape returns to the composer
without closing the workbench.

## Phase 3 — Retroactive discovery and honesty

- [ ] Explicit action only; cancellable; partial results kept
- [ ] Codex attribution by `originator == codex_exec` **plus** a structural
      request signature (`version`, `mode:"ask"`, `input.query` shape) — never
      instruction text, never cwd or turn text
- [ ] Claude indexed-only, labelled; per-provider coverage lines
- [ ] Chat-level caveat that turns are reconstructed; per-gap markers for turns
      that began with no recoverable answer
- [ ] Discovery writes nothing to any provider store

**Automated:** `bun test` — a fixture interactive session discussing shellq in a
matching cwd is **not** indexed; a `codex_exec` session with a matching
signature is; cancellation keeps what was found; a scan leaves every store file
unmodified (mtime and content pinned).

**Human:** run discovery once — 9 real conversations plus 3 labelled fixtures
appear; the coverage header states Claude's indexed-only limit.

## Phase 4 — Close

- [ ] README: `Ctrl-X B`, what discovery does and does not find, where content
      is read from
- [ ] Archive this change into `openspec/specs/shellq/spec.md` in the
      implementing PR

**Automated:** `bun test`, `bunx tsc --noEmit`, `bun run test:fixture`,
`bun run test:pty`, `zsh test.zsh`, `openspec validate --all --strict`.

**Human:** guided Ghostty wizard at 80/100/140 columns, ASCII and Unicode, color
disabled — list and reader legible, actions-sheet header fits with both hints,
footer never exceeds its envelope.

## Not in this change

Reversible local exclusion (`Ctrl-X D` / `V`, tombstones — `d` and `v` stay
free) · pointer input inside the browser · search and filtering · resume from
the browser · cross-machine history · a shellq-owned transcript store · Gemini.

## Sequencing obligation

`add-shellq-streamed-ask-preview` lands after this change and change A. It must
move the index append to its staged-pointer commit hook, pin that with a test,
and ensure preview records never cause an append — in addition to the
requirement-body rebase both earlier changes already require of it.
