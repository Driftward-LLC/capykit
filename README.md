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

The read-only MCP server is available over stdio:

```bash
node dist/mcp.js --registry examples/all-interfaces.registry.json
```

It exposes only `search_tools`, `get_tool`, `list_capabilities`, and
`check_availability`; it does not expose execution or mutation tools. Streamable
HTTP transport is deferred until Capykit has a host authentication/session policy
for HTTP clients so scoped catalog records cannot be disclosed to an
unauthenticated network listener.

CI runs lint, strict type checking, tests, builds, schema validation, and public
repository safety checks. Tagged releases rerun the suite before publishing the
npm package with provenance.

## Capability schema

The versioned registry contract is documented in
[`docs/schema-v0.1.md`](docs/schema-v0.1.md). A public example covering CLI,
MCP, API, service, and skill interfaces lives at
[`examples/all-interfaces.registry.json`](examples/all-interfaces.registry.json).

Registry ingestion, credential references, health checks, and the read-only MCP
surface are constrained by
[`docs/adr/0002-registry-trust-boundaries.md`](docs/adr/0002-registry-trust-boundaries.md).
Deterministic source precedence, explicit override rules, provenance, and
local-file/Git source configuration are documented in
[`docs/registry-loading.md`](docs/registry-loading.md).
The registry doctor's redacted machine-readable report is documented in
[`docs/registry-doctor.md`](docs/registry-doctor.md).
The corresponding machine-readable policy and positive/negative cases live in
[`policies/v0.1/security-policy.json`](policies/v0.1/security-policy.json) and
[`examples/security-policy-cases.json`](examples/security-policy-cases.json).

Run the schema contract tests with Node.js 22 or newer:

```bash
node scripts/test-schema.mjs
node scripts/test-security-policy.mjs
```
