# Tasks — Adaptive frame height

Phases are independently testable. Phases 2–4 are the end-to-end slice under
the Phase 1 contract; Phase 5 is the user-facing surface; Phase 6 is
regression evidence.

## Phase 1 — OpenSpec delta (governing artifact)

- [x] `proposal.md`, `design.md`, `tasks.md`, `specs/shellq/spec.md`
      full-body delta (six modified requirements + one added requirement),
      every patch extracted from canonical text with count assertions
- [x] `openspec validate --all --strict` passes

## Phase 2 — Pure sizing bound (`src/workbench.ts`)

- [x] `FOOTER_MAX_ROWS_OPTIONS = [8, 12, 16]`, `DEFAULT_FOOTER_MAX_ROWS = 12`
- [x] `steppedAskFooterHeight` gains `maxRows` folded into its ceiling;
      `requestedFooterHeight` gains optional `maxRows` (default
      `ASK_STREAM_MAX_FOOTER_HEIGHT`), threaded to its stepped calls, with
      Details/Doctor at `min(12, maxRows)` and the composer at `min(maxRows, …)`
- [x] Omitting `maxRows` reproduces every existing sizing assertion

**Automated:** `bun test test/workbench.test.ts` — per-cap cases: Ask
streaming returns the cap; candidate 8 at cap 8; Details/Doctor `min(12, cap)`;
Settings/actions/editors 8 at every cap; composer bound; cap 16 with a
ten-row terminal returns the physical clamp; defaults unchanged.

## Phase 3 — Persisted key (`src/workbench.ts`)

- [x] `maxFooterRows?: 8 | 12 | 16` on the settings document, allowlist entry,
      membership validation, spread, `writePersistedMaxFooterRows` reusing the
      existing locked atomic updater

**Automated:** round-trip all three values while other keys survive; `6`
throws the invalid-value error; a hand-edited string invalidates the document;
a pre-existing file without the key reads back absent (caller defaults 12);
one focused write-failure check leaves file, marker, and session cap
unchanged.

## Phase 4 — UI slice: frozen session cap (`src/workbench-ui.tsx`)

- [x] Mount-time `useState` read via the nonthrowing state-read pattern;
      `maxRows` passed to the sizing call; saved marker kept separate

**Automated:** focused UI tests — default cap: growth 4 → 8 → 12, never
sixteen, scrollbar present and content reachable; seeded cap 16 reaches
sixteen; cap 8 steps 4 → 8 and stops; the discriminating freeze test
(cap 8, mid-session save 16, content needing sixteen stays at eight; reopen
reaches sixteen); per-invocation persistence across mount/destroy/mount.

## Phase 5 — Palette leaves (`src/workbench.ts`, `src/workbench-ui.tsx`)

- [x] Three `[set]` leaves (`8/12/16 rows`, default marked), action
      `set-max-footer-rows` in the `more` view and global search, handler
      writing only after success, failure status, `current` marker on reopen

**Automated:** save updates `settings.json`, leaves the open band unchanged,
sets the exact status text; `current` shows on reopen; typing `height` from
root lists the leaves; `NO_UNICODE=1` carries the same words; rows fit at 80
columns.

## Phase 6 — PTY, README, full gates

- [x] PTY: seed caps via dedicated state roots under the harness `TEST_DIR`;
      keep the tolerant peak assertion; add a seeded cap-16 case and a
      default-cap case; add a captured-screen residue comparison after
      cap-limited growth plus width shrink/restore (distinguish the SQ-23
      baseline)
- [x] README height passage updated (new default, next-invocation semantics)
- [x] `bun test`, `bunx tsc --noEmit`, `zsh test/test.zsh`,
      `zsh test/workbench-pty-smoke.zsh`, `openspec validate --all --strict`
      on Bun 1.3.3, 1.3.14, and 1.4.2

**Human:** guided run at 80/100/140 columns, ASCII and Unicode, color
disabled — growth stops at the saved maximum, scrolling reaches content, the
palette leaves save and show `current`, and the next invocation applies the
saved bound.

## Not in this change

Cap 4 (needs a compact streaming layout and fixed-slice reachability work —
separate change if wanted) · live cap changes or shrinking · per-workspace or
per-pane caps · manual drag-resize · auto/full-height mode · OpenTUI upstream
resize repair.
