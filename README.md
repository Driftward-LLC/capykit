# Capykit

Capykit is an installable capability registry for people and agents. It gives
every supported agent the same machine-readable answer to three questions:

- What tools are available?
- What can each tool do?
- How should the tool be invoked safely?

Capykit will ship as the `capykit` CLI, the `@driftward/capykit` npm package,
standalone executables, and the `ghcr.io/driftward-llc/capykit` container image.
The CLI and a read-only MCP server will expose the same layered capability
catalog.

The public application contains no Driftward credentials or private capability
records. Driftward-specific catalog data will live in a separate private
registry repository and will be consumed by Capykit at runtime.

## Project status

Capykit is in initial development. The accepted product contract, v0.1 scope,
and ownership boundaries are recorded in
[`docs/adr/0001-product-contract.md`](docs/adr/0001-product-contract.md).

Canonical planning lives in the
[Capykit Linear project](https://linear.app/driftward/project/capykit-72e4a9e54d52).

## Development

The TypeScript application has explicit boundaries under `src/`: `core` owns
catalog behavior, `cli` owns the `capykit` command, `mcp` owns the read-only
`capykit-mcp` server, and `schemas` exposes the versioned registry contract.
Tests mirror those boundaries and use public fixtures only.

Use Node.js 22 or newer:

```bash
npm ci
npm run check
node dist/cli.js --help
```

CI runs lint, strict type checking, tests, builds, schema validation, and public
repository safety checks. Tagged releases rerun the suite before publishing the

npm package with provenance. npm installation, standalone executable artifacts,
checksums, shell completions, upgrade, and uninstall workflows are documented in
[`docs/publishing.md`](docs/publishing.md).

## Capability schema

The versioned registry contract is documented in
[`docs/schema-v0.1.md`](docs/schema-v0.1.md). A public example covering CLI,
MCP, API, service, and skill interfaces lives at
[`examples/all-interfaces.registry.json`](examples/all-interfaces.registry.json).

Registry ingestion, credential references, health checks, and the read-only MCP
surface are constrained by
[`docs/adr/0002-registry-trust-boundaries.md`](docs/adr/0002-registry-trust-boundaries.md).
Deterministic source precedence, explicit override rules, provenance, and
local-file/Git/HTTPS source configuration are documented in
[`docs/registry-loading.md`](docs/registry-loading.md).
The registry doctor's redacted machine-readable report is documented in
[`docs/registry-doctor.md`](docs/registry-doctor.md).
The corresponding machine-readable policy and positive/negative cases live in
[`policies/v0.1/security-policy.json`](policies/v0.1/security-policy.json) and
[`examples/security-policy-cases.json`](examples/security-policy-cases.json).

## Discovery adapters

`capykit adapters /absolute/path/to/registry.json` prints a deterministic
`capykit.discoveryAdapters.v0.1` bundle generated directly from registry
metadata. The bundle contains concise `AGENTS.md` guidance, a Codex discovery
configuration export, and a Hermes reference export. Credential data remains at
the catalog boundary: generated adapters include only declared reference names or
paths and never credential values.

Agents that need a reusable discovery workflow can follow the
[`capykit-agent-discovery` skill](docs/agent-discovery-skill.md). It separates
catalog discoverability from access and authorization, then guides selection
among CLI, MCP, API, service, and skill interfaces before building replacements.

## Approved registry sources

Operators can manage approved registry source configuration with
`capykit sources`. Adds and syncs validate source bytes before atomically writing
the config; Git sources are locked to resolved commits, and HTTPS sources cache
last known-good bytes for deterministic offline sync.

```bash
capykit sources add --config /etc/capykit/registry-sources.json \
  --id team.tools --layer organization \
  --file-root /srv/capykit --file-path team.registry.json

capykit sources inspect --config /etc/capykit/registry-sources.json
capykit sources sync --config /etc/capykit/registry-sources.json --offline
capykit sources remove --config /etc/capykit/registry-sources.json --id team.tools
```

## Read-only MCP server

`capykit-mcp --registry /absolute/path/to/registry.json` exposes the same core
registry loader through four read-only MCP tools: `search_tools`, `get_tool`,
`list_capabilities`, and `check_availability`. The server defaults to `public`
visibility and `agent` audience, and non-public records are disclosed only when
the caller also supplies the matching registry context. Availability checks are
catalog-only: they report declarations but do not execute commands, mutate
state, or probe remote services.

The v0.1 transport is stdio. Streamable HTTP is intentionally deferred until the
package has a settled auth/session model for non-public context disclosure.

The hardened container packaging contract, read-only registry mount defaults,
health check, and resource guidance are documented in
[`docs/container-image.md`](docs/container-image.md).

Run the schema contract tests with Node.js 22 or newer:

```bash
node scripts/test-schema.mjs
node scripts/test-security-policy.mjs
```
