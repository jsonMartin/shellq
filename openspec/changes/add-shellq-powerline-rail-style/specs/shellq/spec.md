## ADDED Requirements

### Requirement: Optional Powerline rail style
The workbench MAY offer an explicit opt-in Nerd Font Powerline rail style. Safe
Unicode SHALL remain the default, font support SHALL NOT be auto-detected, and
the style SHALL NOT change rail meaning, geometry, keyboard behavior, privacy,
or command safety.

#### Scenario: User opts into Powerline
- **WHEN** the user explicitly selects the Powerline rail style on a terminal
  with a compatible font
- **THEN** the status rail may use Nerd Font separators and colored segments
  while preserving its textual labels

#### Scenario: Powerline is not selected
- **WHEN** the Powerline rail style is not selected or Unicode or color is
  disabled
- **THEN** the existing Unicode or ASCII presentation preserves equivalent
  information without private-use glyphs
