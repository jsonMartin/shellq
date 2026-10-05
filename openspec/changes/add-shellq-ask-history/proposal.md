## Why

Every Ask conversation shellq has ever had is invisible. The plugin keeps one
pointer per cwd (`{provider, session_id, cwd}`) and nothing else, so there is no
way to see what you asked, when, or in which directory — only whether *this*
directory has a resumable chat.

The conversations themselves are not lost. Both bundled provider CLIs persist
their own transcripts for headless runs exactly as they do for interactive
sessions, and a session ID maps directly to a file on disk: for Codex it is the
rollout filename UUID and `session_meta.id`; for Claude the session ID *is* the
transcript filename (`~/.claude/projects/*/<id>.jsonl`). Measured on this
machine: a full Codex store scan is 3.75 s over 3,877 rollouts / 11 GB, and 12
shellq Ask rollouts are discoverable — of which **9 are real conversations**,
3 being automated persistence-test sessions.

This change makes that history browsable without shellq storing a second copy of
anything the provider already holds.

An earlier revision of this directory recorded a narrower scope (retain shellq's
own turns per cwd, no browser) built on a premise that direct measurement
disproved: that the question text is never written to the transcript. It is —
the request payload lands one layer down, and a literal `"mode":"ask"` grep
misses it because the payload is JSON-escaped inside a JSON string inside JSONL.
This proposal replaces that content wholesale rather than layering on it.

## What Changes

- Add an append-only local index, one record per Ask conversation, holding
  **locators only**: format version, provider identifier, session ID, cwd, first
  timestamp, and a storage class. No question, answer, preview, or turn text.
- Add a history browser on `Ctrl-X B`: one list across every cwd and every
  provider, with a lazy reader for the selected conversation. It never opens by
  itself and never makes a provider call.
- Add explicit retroactive discovery, so the conversations that already exist
  appear on day one instead of only new ones accumulating. Codex conversations
  are identified by `originator == codex_exec` plus a structural request
  signature; providers that record no provenance are indexed-only and labelled
  as such. No cwd or text heuristics.
- Read provider-native stores **in process**, after an explicit user action,
  treating every byte as untrusted. Nothing is executed to read history.
- State the gaps rather than hiding them: per-provider coverage rows, a
  chat-level caveat that displayed turns are reconstructed, and per-gap markers
  where a turn started with no recoverable answer.
- Do not store transcripts, replay them, or resume from the browser. Do not add
  search, filtering, or cross-machine history.

## Capabilities

### New Capabilities

- `shellq`: Browse past Ask conversations across providers and directories from
  a locator index plus in-process extraction, with no shellq-owned transcript
  store.

### Modified Capabilities

- `shellq`: Admit the history index into the private state root, promote the
  browser to the eight-row envelope, and add `Ctrl-X B`.

## Impact

- **Depends on `add-shellq-multi-provider`.** The index is keyed by provider
  identifier, which that change makes stable, and it reuses that change's
  registry `storeRoot` and history-class declarations. Author and land this
  change after it.
- **Takes the actions-sheet cell that change A deliberately left unspent.** The
  sheet is exactly full at four content rows; `B history` replaces `Esc close`,
  whose `PgUp/PgDn scroll` hint moves to the header row alongside the provider
  hint change A put there. Escape remains universal.
- **Sequencing against `add-shellq-streamed-ask-preview`.** That change moves
  pointer commit into a staged `.pending` → rename transaction. This change
  appends to the index at the current commit point; whoever lands streaming
  moves the append to the staged-commit hook and pins it with a test, alongside
  the rebase this change and change A already require of it.
- **Runtime**: `src/workbench.ts`, `workbench-ui.tsx`, plus per-
  provider extractor modules. No adapter changes. No new dependency.
- **Deferred by decision**: reversible local exclusion (`Ctrl-X D` / `V`) and
  pointer input inside the browser. Both are polish over a keyboard-complete
  browser; those keys stay free for them.
- **Known and accepted**: three of the twelve discoverable Codex conversations
  are test fixtures. They appear, labelled, rather than being removed by a path
  heuristic that could also hide real conversations.
