# Codex onboarding through Capykit

This is the supported v0.1 Codex path for discovering Driftward-approved tools
through Capykit without changing the running Codex tool surface or forwarding
local provider credentials.

## What Capykit manages

Capykit manages discovery metadata and approved registry sources. Codex remains
responsible for its native tools, shell/runtime built-ins, built-in file editing,
and any non-Capykit MCP servers or plugins already configured in Codex. Capykit
cannot rewrite an active Codex session's available tools; reconnect Codex after
operator-approved native MCP changes.

The current package version is `@driftward/capykit` 0.1.1. It supports:

- CLI catalog/source inspection with `capykit sources`, `capykit tools`,
  `capykit adapters`, and `capykit discover host --json`.
- A read-only stdio MCP server, `capykit-mcp`, exposing `search_tools`,
  `get_tool`, `list_capabilities`, and `check_availability`.
- Source-checkout operation with `node dist/cli.js` and `node dist/mcp.js` for
  unreleased profile/source features.

It does not create provider credentials, self-grant permissions, install native
Codex MCP settings, or prove access merely because a catalog record exists.

## Published-package setup

Use this path when the installed npm package is new enough for the needed
feature set.

```bash
npm install --global @driftward/capykit@0.1.1
capykit --version
capykit sources inspect --json
```

Register only operator-approved sources. Example for a local registry file:

```bash
capykit sources add \
  --config "${XDG_CONFIG_HOME:-$HOME/.config}/capykit/registry-sources.json" \
  --id driftward.codex --layer host \
  --file-root /etc/capykit --file-path codex.registry.json

capykit tools search "github issue" --json
capykit tools show <tool-id> --json --check
```

Configure Codex native MCP with stdio after previewing the exact command. Use the
Codex MCP configuration format for the installed Codex version; the command must
be `capykit-mcp` with `--config` pointing at the approved source config.

```text
command: capykit-mcp
args: ["--config", "/absolute/path/to/registry-sources.json"]
```

Restart or reconnect Codex, then run a read-only lookup through the MCP tools.
Search first, inspect the exact tool, and check availability declarations. Treat
`available: null` and `access: "unverified"` as a prompt to verify the selected
native interface separately before use.

## Source-checkout setup

Use this path for unreleased Capykit features from a reviewed checkout.

```bash
npm ci
npm run build
node dist/cli.js sources inspect --config /absolute/path/to/registry-sources.json --json
node dist/mcp.js --config /absolute/path/to/registry-sources.json
```

Codex native MCP should point to `node` with absolute paths:

```text
command: node
args: ["/absolute/path/to/capykit/dist/mcp.js", "--config", "/absolute/path/to/registry-sources.json"]
```

Do not point Codex at an unreviewed working tree for shared host use. Publish or
pin the checkout revision first, then record the revision with the setup.

## Credential and grant boundary

Use a dedicated expiring Codex caller credential when hosted Capykit grants are
available. The credential belongs to the Codex principal only, expires by default,
and is revoked independently from Factory, Hermes, humans, and provider accounts.
Provider credentials remain in their native connection service or host-approved
secret store and are never forwarded to Codex or written into registries,
adapters, docs, diagnostics, argv, or Git.

For v0.1 local discovery, registry records may name credential references such
as environment variable names or protected file paths. They must not contain
credential values. A record being visible means it is declared; it does not mean
Codex can call the provider. Unexpected or ungranted actions must keep failing.
Expired or revoked caller credentials and grants must be denied on subsequent
requests; retrying must not silently fall back to another identity.

## Approved management workflow

1. Inspect the current catalog and native Codex state:
   - `capykit sources inspect --json`
   - `capykit tools search "<task>" --json`
   - `capykit tools show <tool-id> --json --check`
   - `codex mcp list` and `codex mcp get <name>` when Codex is installed
2. Preview a proposed native Codex MCP change as a diff or exact command/args.
   Preserve unrelated native MCP and plugin settings.
3. Get operator approval before enabling, disabling, or changing the Capykit MCP
   integration.
4. Apply the native Codex setting outside Capykit, then restart/reconnect Codex.
5. Run a read-only MCP lookup from a fresh Codex session and record the sanitized
   evidence: Capykit version, config path, source ids, searched query, selected
   tool id, MCP tool name, response shape, and denial evidence for an ungranted
   action. Do not record tokens, provider account values, cookies, or private
   command output.

New grants, provider connections, credential rotation, and revoked/expired
credential repair are operator handoffs. Codex may request them; it must not
self-grant or expand access.

## Safe disable and rollback

Disable Capykit for Codex by removing or disabling only the Capykit MCP entry in
Codex native settings, then restart/reconnect Codex. Leave other MCP servers and
plugins untouched. If a registry source is wrong, remove that source id or roll
back the approved sources file to the previous reviewed version, then restart
`capykit-mcp` or reconnect Codex so the server reloads the catalog.

A rollback is complete when:

- `codex mcp list` no longer shows the Capykit server, or `codex mcp get` shows
  the previous approved command/args.
- `capykit sources inspect --json` shows the intended source set.
- A fresh Codex session cannot call removed Capykit MCP tools, while unrelated
  native tools still behave as before.
