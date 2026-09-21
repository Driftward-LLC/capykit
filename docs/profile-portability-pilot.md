# Portable profile pilot

Date: 2026-09-21. Local, unreleased implementation on Linux with Node.js 24.16.0.

The public `examples/portable-toolkit` bundle was copied into two independent
temporary directory trees, labeled host and laptop. Each tree had its own
download, source configuration, native skill directory, and npm prefix. These
were isolated environments on one machine, not separate operating systems.

Both environments passed the same checks:

| Check | Result |
| --- | --- |
| Apply with `--install-tools` | Installed the catalog, complete skill, and pinned Prettier 3.9.8 |
| Invoke installed Prettier | Reported version 3.9.8 in both prefixes |
| Reapply identical profile | Accepted with the same profile digest |
| Delete original downloaded bundle | Installed catalog and skills remained usable |
| CLI search for `validate JSON` | Found the JSON review skill |
| Run copied `scripts/check-json.mjs` | Validated the test JSON successfully |
| Connect using the reported MCP command | `get_tool` returned the environment's installed `SKILL.md` path |

The shared profile digest was
`58e30cb5d685ba0d79d6dddf7db1c3b2777b72eca140ab1e4c7b82c9aa4c8464`.
Temporary files and dependency installations were removed after verification.
No host catalog, live agent settings, or account connections were changed.

The automated package smoke also installs a packed Capykit build, applies this
profile without npm dependencies, removes the original bundle, and checks that
the installed CLI resolves all copied skill and support files.

This verifies file portability, real npm installation, and CLI/MCP discovery.
It does not establish native skill loading in Codex or Hermes, Windows/macOS
runtime compatibility, account access, or agent productivity improvements.
