# Terminal appearance: independent implementation review

Reviewed on 2026-11-06. The default semantic colors, ANSI palettes and rule sources
were supplied from a separate terminal-appearance-cleanroom workspace. Its handoff
restricted the implementation stage to a self-contained specification, interfaces
and synthetic samples, excluding this repository and third-party terminal sources.
The supplied design notes describe choosing semantic hues, adjusting lightness with
a contrast calculator, and deriving regexes from common log and shell shapes.

This review inspected the supplied materials and integrated code. It did not
observe the original implementation session or independently establish its access
history. The records support the stated process; they are not a legal clearance.
The source workspace also contains subsequent integration corrections, so its
current files should not be treated as an immutable isolation-session transcript.

## Input record

SHA-256 of the supplied records at review time (originals retained outside the
repository; filenames identify the review inputs):

| Record | SHA-256 |
| --- | --- |
| HANDOFF.md | c1931595dc7c2a56a0cd2ecfcaa283933d7eeb302d4030ec93756640e4385df2 |
| SPEC.md | f3d8f2d03678af04cd61c74a0d0df4c1a753a9b28918f68ea7e66c597d8855fa |
| INTERFACES.md | 16392e4a710a02929a2867e6f51ca171263bb8976b287579c71cfd973c06f09e |
| MIGRATION.md | 176e4b90906a7de3ea60e882b7af1b8813a33fa5c7c914cbe4d728b3d2a58379 |
| TESTS.md | a1ee9d3eac2bb7ac5875d89c04914786128654be8e2db0513f570833c418bf6e |
| deliverables/DESIGN-NOTES.md | b995cd30c51c786f037ba2f2341a7ed9384c2675e063aafbcb9379b0c8e779de |

## Integrated behavior

- Semantic colors follow ordinary associations (red errors, green success, amber
  warnings, blue information); dark/light variants meet 4.5:1 on the actual DSH
  backgrounds, #101418 and #f7f8fa. The supplied notes used placeholder backgrounds;
  integration uses the host theme and reruns contrast checks against it.
- ANSI 16-color palettes are independently supplied. They have no 4.5:1 guarantee;
  custom backgrounds and user/server colors are also unrestricted.
- Synthetic log, prompt and file-listing fixtures exercise the real matcher.
  Compiled defaults used by the worker must produce the same fixture spans.
- Review corrections preserve literal legacy contains rules, apply the 8192-character
  limit per entry, preserve quoted-string priority when compiling defaults, avoid
  consuming command arguments after sudo flags, and recognize edge-compressed IPv6.
- All regex matching remains in the existing worker with timeout/quarantine behavior.
  Conflicting fallback wording in the supplied specification was not adopted.

## Saved preferences

This is the first upstream introduction of the feature: ship the new defaults
directly, without a special migration for unpublished default palettes or rules.

The storage key remains dsh-ssh-ops.terminal-display.v1. Preferences without explicit
schemes receive the new defaults. Saved color overrides, custom rules, backgrounds,
entry switches and explicit schemes are preserved; literal rules are escaped when
migrated to regex. Explicit schemes have no provenance marker capable of separating
an old default from a user edit: their colors and text are treated as user data.
Consequently a saved full scheme can retain old values until the user resets it.
No old palette or rule text is embedded as a migration lookup table.

## License and validation scope

The upstream MIT LICENSE is unchanged. Obsolete terminal-resource and inherited
palette notices are removed for the replaced defaults. Apache-2.0.txt and bundled
npm dependency notices remain, including MongoDB/BSON-related licenses. This change
does not add or upgrade dependencies.

Run npm test, npm run lint, npm run build and node tools/check-contrast.mjs.
The three terminal-appearance test suites are included in npm test and CI.
Interactive acceptance inside a running DSH host remains a manual check; automated
xterm/worker tests do not establish desktop appearance or mouse interaction.
