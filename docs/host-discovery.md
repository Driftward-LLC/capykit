# Generated host discovery

Build the current checkout, then run `node dist/cli.js discover host --json`.
An installed build exposes the same command as `capykit discover host --json`.
`--path <path>` selects the executable inventory. Regular executable files and
executable symlinks are included; directories, broken links, and non-executable
files are omitted.

Default discovery does not execute any subprocess, read credential stores, or
contact providers. It records PATH commands and helpers only. When Codex is
present, `extensions["x-codex-metadata-status"]` is `not-requested`; otherwise it
is `not-installed`. This is deliberately incomplete for MCP and plugin coverage.

## Optional Codex discovery and its credential boundary

`capykit discover host --json --allow-codex-auth` explicitly permits the selected
Codex executable to run `mcp list`, `mcp get <name>`, and `plugin list --json`.
These commands can read configured authentication, check MCP auth, and contact
MCP or plugin marketplace providers. The behavior was verified against
[Codex 0.154 MCP listing](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/mcp_cmd.rs)
and [plugin listing](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/cli/src/plugin_cmd.rs).
There is no offline, credential-free listing mode in that version. Do not enable
this flag in a bootstrap that requires no credential reads or provider calls.

With this opt-in, `--path` also chooses the Codex executable. Installed, enabled
plugins and enabled MCP configurations become catalog entries, with metadata
status `collected`. Unsupported output, failed commands, or stderr diagnostics
fail the refresh instead of silently publishing an incomplete inventory.
Commands have bounded output and timeouts. Discovered tools and MCP launchers
are never executed by Capykit, and plugins are not installed.

MCP parsing consumes Codex's human-readable output, which masks configured
environment and header values; it never requests MCP JSON output. Only explicit
environment variable names are retained, including names ending in `TOKEN` or
`SECRET`.

Codex can still put sensitive data in command arguments or endpoint URLs in its
human-readable output. Capykit discards those fields, never logs raw metadata or
child-process errors, and does not copy MCP launch commands or URLs into the
registry. This prevents those fields from entering the catalog; opt-in Codex
commands can still read or return credentials internally. Keep credentials out
of command arguments and URLs.

Generated MCP entries reference the existing configuration through the `codex`
CLI. Their extensions record the server name and actual `stdio` or `http`
transport. They are discovery references, not standalone MCP connection
configurations. Supply reviewed native MCP interfaces in a separate operator
record when those are needed. Generated safety requires approval; availability
and environment references do not prove authentication or authorization.

## Private files and atomic refresh

Host inventories can contain private tool names. Keep them outside this public
repository. This example writes a candidate with private permissions, validates
it, and atomically replaces only the generated registry:

```bash
set -e
umask 077
registry_dir="${XDG_CONFIG_HOME:-$HOME/.config}/capykit"
mkdir -p "$registry_dir"
candidate="$(mktemp "$registry_dir/.host-generated.XXXXXX")"
trap 'rm -f "$candidate"' EXIT
capykit discover host --json > "$candidate"
capykit doctor "$candidate" > /dev/null
mv "$candidate" "$registry_dir/host-generated.registry.json"
```

`capykit discover host --format-version` prints `2` without inspecting the host.
Bootstrap integrations must check support before running discovery with an
older build. The generated document also includes
`extensions["x-host-discovery-version"] = 2` for candidate validation.
Failed discovery or validation must leave the previous
catalog in place. Doctor validates the schema and credential boundary; command
lookups are skipped unless individually approved with `--allow-command` and
never execute a tool.

## Sources and operator annotations

Register the generated file once at the `host` layer:

```bash
capykit sources add \
  --config "$registry_dir/registry-sources.json" \
  --id host-generated --layer host \
  --file-root "$registry_dir" --file-path host-generated.registry.json
capykit tools list --json
capykit tools show codex-cli --check
capykit adapters > "$registry_dir/discovery-adapters.json"
```

Use an absolute file root so the configuration works from any directory.
Local file sources read the current validated file on each load; use
`sources sync --config <path> --id host-generated` to refresh the recorded lock.

Keep operator annotations in a separate `user` source with explicit
`--override <tool-id>` entries. An annotation replaces the entire tool record;
it is not a partial field patch. Sources in the same layer cannot overlap.
Existing organization or host records may also require an explicit override
decision before adding the generated source. Bootstrap must not silently move
sources, synthesize approval metadata, or overwrite operator records to resolve
these conflicts. See [registry loading](registry-loading.md).

Tool removal can make an operator override stale. Validate the effective
catalog before activating an automated refresh and preserve the previous
catalog if its source configuration no longer resolves.
