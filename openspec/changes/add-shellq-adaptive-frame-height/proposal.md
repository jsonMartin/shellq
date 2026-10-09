## Why

SQ-11 asks the workbench to adapt its height to content with a configurable
cap. Content-driven 4/8/12/16-row growth already exists and is specified;
what is missing is the user-configurable maximum. Today the ceiling is fixed
at sixteen rows, so users sharing a terminal with other panes cannot bound the
workbench's vertical footprint.

## What Changes

- Add one global, persisted setting: the maximum workbench frame height,
  offered as 8, 12, and 16, defaulting to 12, stored as a single additive key
  in the existing version-2 settings document.
- Bound every workbench surface by the configured maximum on the next
  invocation: content growth stops at the maximum and scrolls beyond it. No
  surface exceeds it, and no surface uses an unapproved floor above it.
- Cap 4 is deliberately not offered: the panel showed a four-row frame cannot
  host the streaming reader or the palette's mandated interior rows without
  render work and a maximum-violating floor, so the honest offered set keeps
  the universal maximum true. (Owner decision recorded 2026-10-07.)
- Apply the cap at mount only: an open workbench never re-reads the setting,
  and frame height stays grow-only within an invocation.
- Expose the setting as three-value leaves under the existing
  `More settings & actions` palette view; no new root palette parent, no new
  settings framework.
- Update the height passages in README to the new default and semantics.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `shellq`: the frame sizing requirements become bounded by the configured
  maximum; a new global setting requirement specifies the offered values,
  default, next-invocation semantics, and no-send-on-save.

## Impact

- Code: the two pure sizing functions in `src/workbench.ts` gain a `maxRows`
  bound; the settings document gains one allowlisted key and one writer
  reusing the existing locked atomic updater; `src/workbench-ui.tsx` reads the
  cap once at mount and adds the palette leaves.
- Defaults change behavior: Ask answers and finished candidates that today
  grow to sixteen stop at twelve until the user raises the maximum. Tests
  asserting sixteen are re-seeded or moved to the default.
- No OpenTUI transition path changes: the cap only lowers a requested height,
  the direction already proven safe; the SQ-23 resize-scrub baseline and the
  SQ-24 grow-only constraint are preserved and re-verified with a
  captured-screen check after cap-limited growth and resize.
- No new dependency, no provider behavior change, no change to the
  never-auto-execute contract or the receipt bound (peaks remain ≤ 16).
