# Third-party notices

This project's original code is licensed under [MIT](LICENSE). The third-party material below remains subject to its own license terms. The root MIT license and the package's project-license metadata do not replace those terms.

## Terminal palettes and semantic rules

The default terminal appearance shipped by this plugin — the ANSI palettes in `src/client/terminal-display/theme.js`, the semantic classification rules in `src/client/terminal-display/rules.js`, and the color-scheme defaults in `src/client/terminal-display/scheme.js` — is designed in-house for this project. It was derived from the product requirements and common terminal behavior (logging levels, shell output shapes, WCAG contrast), not adapted from another terminal application's palettes, rule sets or lexer sources. These files are covered by the project's own [MIT license](LICENSE) and carry no third-party terminal project's copyright, attribution or source references.

Implementation provenance and integration limits are recorded in [the clean-room review](docs/terminal-appearance-cleanroom.md).

Readability of the semantic defaults is checked by `test/terminal-appearance-contrast.mjs` (WCAG AA 4.5:1 on each theme's DSH background), and the semantic behavior by `test/terminal-appearance-semantic.mjs` plus the terminal-display regression tests.

## Bundled npm dependencies

Some development dependencies are incorporated into the shipped bundles. They are not all MIT: MongoDB-related code uses Apache-2.0, and webidl-conversions uses BSD-2-Clause. Full package license texts, including nested vendor license files, are included in [licenses/bundled-dependencies.txt](licenses/bundled-dependencies.txt). Both npm tarballs and source release archives carry this file and the Apache-2.0 text.

### Host bundles

| Package | Version | License |
| --- | --- | --- |
| `@mongodb-js/saslprep` | 1.4.13 | MIT |
| `bson` | 6.10.4 | Apache-2.0 |
| `memory-pager` | 1.5.0 | MIT |
| `mongodb` | 6.21.0 | Apache-2.0 |
| `mongodb-connection-string-url` | 3.0.2 | Apache-2.0 |
| `punycode` | 2.3.1 | MIT |
| `sparse-bitfield` | 3.0.3 | MIT |
| `tr46` | 5.1.1 | MIT |
| `webidl-conversions` | 7.0.0 | BSD-2-Clause |
| `whatwg-url` | 14.2.0 | MIT |
| `zod` | 4.4.3 | MIT |

### Client bundle (including xterm CSS)

| Package | Version | License |
| --- | --- | --- |
| `@xterm/addon-fit` | 0.10.0 | MIT |
| `@xterm/addon-search` | 0.15.0 | MIT |
| `@xterm/xterm` | 5.5.0 | MIT |
| `zod` | 4.4.3 | MIT |

The highlight worker bundles this plugin's source and no npm package code. External runtime dependencies such as ssh2, mysql2, pg, pg-cursor and redis are installed separately by the package manager with their own license files; retain those files when redistributing an assembled installation. React and DSH peer packages are supplied externally by the host.

The full locked-dependency inventory, optional-package checks and audit limits are documented in [dependency license audit](docs/dependency-licenses.md). This audit concerns the pinned client/driver packages, not the separately licensed MongoDB or Redis server products.
