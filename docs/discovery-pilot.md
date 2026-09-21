# Task discovery pilot

The first task-discovery slice was compared with source baseline `bded5d1`
using the public `examples/all-interfaces.registry.json` fixture. The comparison
used actual CLI subprocesses and MCP stdio clients against a saved baseline
build and the updated build.

| Task keywords / interface | CLI search before → after | MCP search before → after |
| --- | --- | --- |
| `transform JSON` / CLI | unsupported → pass | pass → pass |
| `current service status` / API | unsupported → pass | no match → pass |
| `research sources` / skill | unsupported → pass | no match → pass |
| `read approved file` / MCP | unsupported → pass | no match → pass |
| `local document index` / service | unsupported → pass | pass → pass |

A search passes when the expected tool is the first result. The CLI used the
local operator's catalog. MCP requests for organization and host records
included their required visibility and matching example context.

| Detail and configuration check | Before | After |
| --- | --- | --- |
| CLI exact-ID details retain invocation fields, auth guidance, and examples | 5/5 | 5/5 |
| MCP exact-ID details retain those fields | 0/5 | 5/5 |
| MCP task discovery through default configured sources | 0/5 | 5/5 |
| Adapter export through default configured sources | unsupported | succeeds |
| MCP hides scoped records with default, missing, or incorrect context | passes | passes |
| MCP availability for a declared API | `available: true` | `declared: true`, `available: null`, `access: "unverified"` |

Required invocation fields were the CLI command, MCP server/transport/command,
API base URL and operations, service manager/name, and skill location/format.
This verifies that discovery preserves the declared next step; it does not
verify installation, authentication, or successful execution of those tools.

Regression coverage for the workflow is checked in. Run:

```bash
npx vitest run tests/discovery-flow.test.ts tests/mcp.test.ts tests/adapters.test.ts
npm run check
```

The fixtures exercise all five interfaces, effective-source overrides, task
keywords in any order, command lookup on an isolated PATH, scoped disclosure,
invalid arguments, missing configuration, and detail exports. The package smoke
test also exercises the built MCP server over stdio.

This is a functional comparison of two interfaces. No external operations or
model sessions were run, so it does not establish agent productivity or a speed
improvement. The next adoption measurement is to run the same real tasks in two
configured agent environments, with and without Capykit, and compare correct
first tool choice, task completion, discovery time, and unnecessary scripts.
