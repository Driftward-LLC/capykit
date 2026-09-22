# Capykit

Capykit is being built as a hosted capability platform for people and agents.
The app will store connections, functions, tools, and skills centrally and
provision authorized access and execution when requested from the web app,
API, CLI, or MCP. See the
[hosted product direction](docs/adr/0004-hosted-capability-platform.md).

The current implementation is the installable discovery and local setup
foundation. Hosted connections, function execution, and the web app are not yet
implemented. The existing catalog answers three questions:

- What tools are available?
- What can each tool do?
- How should the tool be invoked safely?

Capykit ships as the `capykit` CLI, the `@driftward/capykit` npm package,
standalone executables, and the `ghcr.io/driftward-llc/capykit` container image.
The CLI and a read-only MCP server expose the same layered capability catalog.

The public application contains no Driftward credentials or private capability
records. Driftward-specific catalog data will live in a separate private
registry repository and will be consumed by Capykit at runtime.

## Project status

The hosted product direction is recorded in
[`ADR 0004`](docs/adr/0004-hosted-capability-platform.md), including the first
complete user-and-agent invocation milestone. The existing v0.1 discovery
package and its original ownership boundaries are recorded in
[`ADR 0001`](docs/adr/0001-product-contract.md).
Discovery-package v0.1 completion requirements are tracked in
[`docs/v0.1-requirements.md`](docs/v0.1-requirements.md).

Canonical planning lives in the
[Capykit Linear project](https://linear.app/driftward/project/capykit-72e4a9e54d52).

Portable environment profiles, task search, shared MCP source configuration,
and expanded discovery details are unreleased changes in this checkout.
Build from source to try them using
`node dist/cli.js` and `node dist/mcp.js` until a new package release is published.

## Install

Install the published npm package on a machine with Node.js 22 or newer:

```bash
npm install --global @driftward/capykit@latest
```

Confirm the CLI is available:

```bash
capykit --version
capykit --help
```

Already have a local project and want a one-off run instead of a global
install?

```bash
npm exec --package @driftward/capykit@latest -- capykit --help
```

## Quick start

Download the public example registry, validate it, and generate discovery
adapters. These examples demonstrate discovery; most describe fictional tools.

```bash
REGISTRY_URL="https://raw.githubusercontent.com/Driftward-LLC/capykit/main"

curl -fsSL "$REGISTRY_URL/examples/all-interfaces.registry.json" \
  -o capykit.registry.json

capykit doctor capykit.registry.json
capykit adapters capykit.registry.json > capykit.discovery.json
capykit-mcp --registry "$PWD/capykit.registry.json"
```

The published package can read an explicit registry. Task search and shared
source configuration below require a build of the current checkout.

## Try task discovery from source

Run these commands from the repository checkout:

```bash
npm ci
npm run build

node dist/cli.js sources add \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/capykit/registry-sources.json" \
  --id public.examples --layer user \
  --file-root "$PWD/examples" --file-path all-interfaces.registry.json

node dist/cli.js tools search "filter JSON"
node dist/cli.js tools show jq --check
```

Search finds tools by task keywords. Inspect a match to get its invocation
details, examples, safety metadata, authentication references, and documentation.
`--check` looks up the declared CLI command on PATH; it does not verify access
or execute the tool. Add `--json` for machine-readable search or detail output.

The CLI, adapters, and read-only MCP server share your configured sources:

```bash
node dist/cli.js adapters > capykit.discovery.json
node dist/mcp.js
```

Pass `--config <path>` to any of those entry points to choose another sources
configuration. For a single file without registration, use
`capykit adapters <registry.json>` or `capykit-mcp --registry <registry.json>`.

## Use the same skills and tools in another environment

A versioned environment profile bundles a registry, complete skill folders,
optional pinned npm dependencies, and connection instructions. Share the folder
through Git or an archive, then apply it in each environment. The included
JSON toolkit works with the local build:

```bash
npm ci
npm run build
node dist/cli.js profile inspect examples/portable-toolkit/profile.json --json
node dist/cli.js profile apply examples/portable-toolkit/profile.json --install-tools
```

Use `--config <path>` for an isolated configuration and `--skills-dir <path>`
to copy skills into an agent's native skill directory. The report gives you the
MCP connection and dependency `PATH` to configure for that environment.
Connections still need their own authentication. See
[environment profiles](docs/environment-profiles.md) for sharing, upgrades,
and the complete setup flow. Profile commands are currently unreleased.

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

`capykit adapters` prints a deterministic
`capykit.discoveryAdapters.v0.1` bundle generated directly from registry
metadata. The bundle contains concise `AGENTS.md` guidance, a Codex discovery
reference export, and a Hermes reference export. Detail exports retain CLI/MCP
invocation fields, API operations, service identifiers, skill locations,
examples, safety, and documentation. Credential data remains at
the catalog boundary: generated adapters include only declared reference names or
paths and never credential values.

Exports are returned as `{path, content}` entries; the command does not install
them or overwrite agent configuration. `.codex/capykit.discovery.json` is a
reference that must be read explicitly. Generated guidance uses the embedded
catalog; a later live CLI query needs the same source configuration to avoid
querying a different catalog. Use `--config <path>` for alternate
configured sources, or a positional registry file for an isolated export.

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

For day-to-day discovery, `capykit tools` and `capykit tools list` read the
effective catalog from `$XDG_CONFIG_HOME/capykit/registry-sources.json`, falling
back to `~/.config/capykit/registry-sources.json`. Pass `--config <path>` to
override the default for admin and test workflows. List, search, and show support
`--json` for deterministic agent-readable output.

`capykit tools search "deployment logs"` matches all whitespace-separated
keywords, in any order, across names, summaries, invocation identifiers,
capabilities, API operations, and examples. Matching is case-insensitive;
results retain catalog order. Use a few task keywords rather than a full
question. No match returns an empty result, without suggesting an invented tool.

Plain tools output is a declaration view: it shows what the effective catalog
claims, not whether those commands are installed. Use `capykit tools check` or
`capykit tools list --check` to add command availability metadata. Availability
checks only look up command tokens on the selected PATH and never execute tool
commands. Pass `--path <path>` when you need an explicit operator-approved PATH,
for example to avoid counting bundled agent helper directories as host-wide
availability.

```bash
capykit tools
capykit tools list --json
capykit tools search "deployment logs" --json
capykit tools check --path /usr/local/bin:/usr/bin --json
capykit tools show shared-tool --config /etc/capykit/registry-sources.json --check
```

## Read-only MCP server

`capykit-mcp` loads the same approved source configuration as the CLI, with
`--config <path>` available for overrides. A missing configuration produces an
actionable error on the first catalog request. `--registry <registry.json>`
continues to support standalone registry files; it cannot be combined with
`--config`. The server exposes four read-only MCP tools: `search_tools`, `get_tool`,
`list_capabilities`, and `check_availability`. The server defaults to `public`
visibility and `agent` audience, and non-public records are disclosed only when
the caller also supplies the matching registry context. For example, a host
record scoped to `example-host` requires `visibility: "host"` and
`context: "example-host"` on each request. Sharing configuration does not make
non-public records visible by default.

Search uses the same keyword matching as the CLI and returns summaries.
`get_tool` returns full validated invocation details, examples, authentication
references, and safety metadata. `list_capabilities` includes API operations.
The server loads its catalog on the first request and caches it; restart it
after changing or synchronizing sources.

Availability checks remain catalog-only. A matching interface returns
`declared: true`, `status: "declared"`, `available: null`, and
`access: "unverified"`; an absent requested interface returns `declared: false`,
`status: "not-declared"`, and `available: false`. They do not execute commands,
read credentials, or probe services. This corrects earlier releases that
returned `available: true` for a declaration. Consumers should use `declared`
for catalog presence and treat `available: null` as unknown. CLI `--check`
continues to report command presence separately, with access unverified.

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
