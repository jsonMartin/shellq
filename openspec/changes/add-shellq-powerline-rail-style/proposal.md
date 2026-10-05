## Why

Users with a Nerd Font may prefer a richer Powerline-style status rail, but
font support cannot be detected reliably. The portable Unicode rail should
remain the default while beta users can explicitly opt into the enhanced look.

## What Changes

- Add an explicit opt-in `powerline` rail style using Nerd Font separators and
  colored status segments.
- Keep safe Unicode as the default and preserve ASCII, no-color, and
  no-Unicode fallbacks with equivalent textual meaning.
- Do not auto-detect fonts or change workbench geometry, keyboard behavior,
  providers, privacy, command acceptance, or never-auto-execute safety.
- Defer design and implementation until beta; this proposal records scope only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `shellq`: Add an optional presentation style for the existing status rail.

## Impact

- Later beta work is limited to the existing rail renderer, theme/glyph
  selection, focused presentation tests, and user documentation.
- No new dependency, settings framework, or current production behavior is
  introduced by this proposal.
