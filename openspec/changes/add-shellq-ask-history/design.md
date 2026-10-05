## Current implementation prerequisites

The copied MODIFIED requirements have been refreshed from canonical without
changing the proposed browser or retention policy. This is not implementation
approval. Before implementation, verify extraction against the current isolated
App Server Ask store and current request shape; Ask threads are persistent,
while Command/Fix threads are ephemeral. Local Ask has no native history store
or pointer and cannot gain recoverable history from locators alone. Decide its
coverage explicitly before changing any retention behavior.

Streaming and staged pointer commits already exist. Reconcile the older
sequencing tasks with the current commit hook. Corpus measurements below came
from an earlier machine and are historical evidence, not current maintainer counts.

# Design — Ask history browser

## Locators, not content

The index stores where a conversation is, never what it said:

```jsonc
{"v":1,"provider":"codex","session_id":"<uuid>","cwd":"/abs/path",
 "first_ts":"2026-08-05T14:03:11Z","storage":"native"}
```

`cwd` is stored rather than derived because only Codex exposes it cheaply —
`session_meta` on line 1, 27 ms for 12 files. Claude mangles it into a directory
name (`-Users-json--herdr-worktrees-…`) and Gemini stores a one-way
`projectHash`. Without a stored cwd a Claude or Gemini row cannot be rendered at
all, and a row for a conversation whose transcript has since been pruned cannot
even be sorted.

`storage` names where content lives, so a provider whose store is gone still
gets an honest row instead of silently vanishing.

One `O_APPEND` write of a line under `PIPE_BUF` is atomic, so concurrent
invocations cannot interleave and no read-modify-write exists — which is why
there is no lock here and no compaction. At ~120 B per record and 12
conversations across five weeks of heavy use, a 512 KiB file is decades away.

## Extraction runs in process

The alternative was a `mode: "history"` verb on the provider adapters. Rejected:
the adapters are bundled by shellq either way, so a subprocess buys process
isolation, not decoupling — and it would need the *Resumable Ask conversations*
"no provider call" sentence weakened, which in-process reads do not.

All stores are local files. The requirement's new sentence scopes the exemption
narrowly: an in-process read after an explicit user action is not a provider
call, and it may not be done merely to open the workbench or display resumable
state.

Every byte is untrusted: bounded read, symlink and non-regular rejection, and
revalidation against the same predicates a live answer passes before display.

## What the corpus actually contains

Measured, and each fact changes a design decision:

| Measurement | Consequence |
|---|---|
| Bare marker matches 30 files; only 12 are `codex_exec` — 18 are the user's own interactive sessions *about* shellq | Provenance is load-bearing; a text or cwd heuristic would index 18 conversations that are not shellq's |
| 3 of the 12 are automated persistence-test sessions | The real corpus is 9. They appear labelled; no path heuristic filters them, because one that hides fixtures can hide real work |
| 48 `task_started` vs 43 string `last_agent_message`; 44 queries recovered | Real cancelled and unpaired turns exist, so per-gap markers are required, not decorative |
| `function_call_output.output` is a string in 38 records and a list in 6, same corpus | A string-only extractor silently loses ~14% of queries. Fixtures pin both shapes |
| Request `instructions` text drifted between shellq versions | The signature matches `version` + `mode:"ask"` + `input.query` structure, never instruction text |
| 38/44 queries are recoverable only because the model chose to `cat` `request.json` | This is model behaviour, not a format guarantee. A missing query is a **gap**, never an error |
| Claude's first record carries `sessionId` but no originator | Claude is indexed-only: conversations shellq indexed going forward are browsable, earlier ones cannot be identified, and the browser says so |
| Full scan: 3.75 s over 3,877 rollouts / 11 GB | Discovery is cheap enough to be one explicit action, and expensive enough that it must never be implicit |

## Actions sheet

Change A left one cell unspent for this. The sheet is header + rule + 4 content
rows = 6 interior rows, exactly the envelope. `B history` takes the `Esc close`
cell; that cell also carries the `PgUp/PgDn scroll` hint when a candidate list
exists (`workbench.ts:1503-1510`), so the hint moves to the header row, where
change A already put the provider hint. Escape stays universal, so removing its
cell removes a label, not a capability. Verify the header still fits at 80
columns with both hints present.

## Deferred, with the keys reserved

- **Reversible local exclusion** (`Ctrl-X D` hide, `V` show hidden) — tombstone
  records in the same append-only ledger. Cut to keep this change landable; `d`
  and `v` stay free. Exclusion without restore is not reversible, so if one
  ships they both do.
- **Pointer input in the browser** — row click to select, wheel to scroll the
  list or reader under the pointer. The browser is keyboard-complete without it.

## Sequencing

Depends on `add-shellq-multi-provider`: the index is keyed by provider
identifier, and it reuses that change's registry `storeRoot` and history-class
declarations.

`add-shellq-streamed-ask-preview` moves pointer commit into a staged
`.pending` → rename transaction. This change appends at the current commit
point. Whoever lands streaming moves the append to the staged-commit hook and
pins it with a test — and preview records must never cause an append, since they
never commit a pointer. That is in addition to the requirement-body rebase both
this change and change A already require of it.

## Non-goals

Search and filtering · resuming a conversation from the browser · cross-machine
or synced history · a shellq-owned transcript store · per-turn display-fidelity
labels (one chat-level caveat plus per-gap markers instead, because per-turn
precision is unrecoverable anyway and would burn reader rows).
