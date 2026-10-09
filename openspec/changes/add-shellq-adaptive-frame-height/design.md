## Design — SQ-11 adaptive frame height (planning panel outcome)

Light planning panel, 2026-10-07. Proposal: `claude-fable-5-1` at xhigh
(blind); adversarial attack: `gpt-6-astra` at xhigh (fresh, opposite system);
synthesis and adjudication: the coordinating Opus 5.5 session. All six
material criticisms were accepted and are incorporated here. Provenance
disclosure: the planner saw an abandoned draft at its output path from a
mis-dispatched earlier run; the attacker weighed this and verified the
synthesis on its own merits.

### Central finding (verified)

Content-driven 4/8/12/16 stepped growth already exists
(`steppedAskFooterHeight`, `src/workbench.ts:2075-2081`) and is already
specified. SQ-11 reduces to: a persisted, user-configurable maximum bounding
the band on the next invocation.

### Decisions

1. **Universal maximum, no floors; cap 4 dropped from the offer.** The
   planner's eight-row floor under cap 4 was refuted: the grow-only peak
   effect (`src/workbench-ui.tsx:756-763`) makes any eight-row surface visit
   pin the band at eight for the rest of the invocation, and a four-row frame
   cannot mount the streaming text reader or its scrollbar at all
   (render branch requires more interior rows). Offering 8/12/16 keeps
   "the band never exceeds the configured maximum" literally true everywhere;
   at eight rows every fixed eight-row SHALL is satisfied exactly.
   Owner approved dropping 4 on 2026-10-07.
2. **Placement P2**: the setting is three `[set]` leaves under the existing
   `More settings & actions` view. A sixth root parent would overflow the
   five-slot painted window (`SETTINGS_PICKER_VISIBLE_ROWS = 5`,
   `src/workbench.ts:3991`) and rewrite the closed root set in the spec.
3. **Persistence**: one additive `maxFooterRows` key in the version-2
   settings document, through the existing conservative allowlist parser and
   the existing locked atomic updater. Absent key → default 12. No new
   repair, locking, or partial-parse machinery; invalid values invalidate the
   document exactly like any other key.
4. **Next-invocation semantics**: freeze the cap in a mount-time `useState`
   initializer (the `initialChoices` pattern, nonthrowing state read); a
   separate saved value feeds the picker's `current` marker. A mid-session
   save changes the marker, not the open band.
5. **Freeze test must discriminate**: start at cap 8, save 16 mid-session,
   feed content needing sixteen → the band stays at eight; reopen → it
   reaches sixteen. A save-while-at-peak test cannot distinguish frozen-cap
   from peak retention.
6. **Resize evidence**: Phase 6 adds a captured-screen comparison after
   cap-limited growth plus width shrink/restore. Known pre-existing defects
   (SQ-23 scrub residue; the prompt-row loss at terminal heights below the
   requested peak) are baselines to distinguish, not regressions to hide, and
   no shrinking mode is introduced to mask them.
7. **README**: the height behavior is documented (README height passage) and
   must be updated to the new default and semantics; the planner's claim that
   no README text exists was refuted.

### Rejected alternatives

- **A — content-growth cap only** (Details/Doctor stay at twelve under cap
  eight): rejected; it redefines the maximum per surface. Its one advantage
  (fewer spec sentences) does not survive the universal reading the owner
  asked for.
- **C — hard cap including cap 4**: rejected for this change; honoring four
  rows needs a compact streaming layout that can show text and a scrollbar
  plus fixed-slice content-reachability decisions, and the picker windowing
  delta on the palette requirement. Feasible future work if the owner wants a
  four-row workbench; not a bound-only change.
- **P1 — sixth root palette parent**: rejected; hides `More settings &
  actions` below the five-slot window until the user scrolls.

### Deal killers

- A governing delta that leaves any conflicting SHALL (e.g. Doctor's
  twelve-row clauses) unmodified — the delta enumerates every conflicting
  requirement; structural validation alone is not enough.
- Introducing a live re-read or a shrinking mode to simplify resize behavior.
- Letting the receipt claim less than the effective peak (the receipt bound
  and 1..16 zsh acceptance stay unchanged).
