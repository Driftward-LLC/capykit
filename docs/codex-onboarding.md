# Codex onboarding through Capykit

Use Capykit's existing remote stdio client for authenticated hosted actions.
Local catalog discovery is separate: a declared tool is not provider access.
Capykit does not manage Codex sessions or rewrite their native tool surface.

## Version and delivery boundary

As checked on 2026-10-05, this repository's `main` and published discovery
package `@driftward/capykit@0.1.1` do **not** include the hosted remote client.
Do not install `latest` and assume `--remote` is supported. Source builds still
report version 0.1.1, so record their full Git revision as well.

The hosted client is in the integration history for
[PR #53](https://github.com/Driftward-LLC/capykit/pull/53), not delivered by this
documentation PR. This guide targets immutable source revision
`84ba19cfd334cdb109e209f32d2f72617ae45076`. Its
[remote client](https://github.com/Driftward-LLC/capykit/blob/84ba19cfd334cdb109e209f32d2f72617ae45076/src/mcp/remote.ts)
implements the tools below. Review that source before installing it; pinning
is not security approval or proof of live compatibility.

Build that revision in a separate checkout with Node.js 22 or newer:

```bash
git clone https://github.com/Driftward-LLC/capykit.git capykit-codex-client
cd capykit-codex-client
git checkout --detach 84ba19cfd334cdb109e209f32d2f72617ae45076
npm ci
npm run build
git rev-parse HEAD
```

Use the resulting absolute `dist/mcp.js` path. Do not point a shared integration
at a mutable development checkout. Keep the installation protected from
untrusted writes. This builds a client; it does not deploy Capykit's server.

## Provision access separately

In hosted Access, an operator creates a dedicated **Codex** caller using
**Create agent and key**, with an explicit short expiry. This legacy label
creates a caller identity, not an executor. Grant only the selected read-only
action on one approved connection and its supported resource scope. Credential
possession alone grants no provider access.

Have the operator supply these to the host Codex process from protected runtime
configuration or a secret manager:

- `CAPYKIT_BASE_URL`: the approved HTTPS origin, without a path or query.
- `CAPYKIT_API_KEY`: that dedicated, expiring Capykit caller key.

Do not reuse Factory/Hermes keys, browser sessions or provider credentials.
Never put the key in argv, `codex mcp add --env`, TOML `env` values, registries,
shell history, diagnostics or Git. Do not paste it into chat. Environment
injection is not a vault: processes with that environment can read the key.

Connections, grants, rotations and scope expansions need operator approval.
Codex must not self-grant, switch identity after denial, or change shared
Hermes/Factory configuration.

## Preview and approve native configuration

Use native
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
Preview exact paths, origin, forwarded variable names and enabled tools.
Inspect the existing entry privately, back up the configuration privately, and
preserve unrelated MCP/plugin settings. Never print a whole configuration that
may contain secrets. Apply only after operator approval.

Add or update only `[mcp_servers.capykit]` in the selected Codex configuration:

```toml
[mcp_servers.capykit]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/capykit-codex-client/dist/mcp.js", "--remote"]
env_vars = ["CAPYKIT_BASE_URL", "CAPYKIT_API_KEY"]
enabled_tools = ["list_actions", "get_action", "list_connections", "list_connection_actions"]
enabled = true
```

This discovery-only allowlist deliberately excludes execution. Verify the
installed Codex supports these settings using its
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Restart/reconnect into a fresh session receiving the protected environment.
`codex mcp get capykit` proves configuration only; an authenticated tool call
is still required. There is no hosted `/mcp` endpoint or OAuth login here: the
local stdio client calls Capykit's REST API. Do not combine `--remote` with
local `--config` or `--registry` arguments.

## Discover, inspect, then run

The action families have different identifiers and argument shapes:

- Workspace GitHub/Drive: `list_actions`, then `get_action` with `id`;
  execute with `run_action`.
- Personal/shared accounts: `list_connections`, then `list_connection_actions`
  with `connectionId`; execute with `run_connection_action`.

Inspect exact schemas, connection IDs, resource choices and granted actions.
Do not infer authority from the public connector catalog or invent IDs. An
empty authorized list means no matching access, not successful onboarding.

For the approved canary, preview a second configuration change adding only the
necessary execution tool to `enabled_tools`. Obtain approval and reconnect.
`run_action` takes `id`, `connectionId`, and `input`, for reviewed workspace
read actions. `run_connection_action` takes `connectionId`, `action`, and
`input`; it is generic and can perform writes. Its tool name is **not** a
read-only restriction. Server grants must restrict it to the approved read
action; the native allowlist cannot constrain arguments.

Invoke only the test issue/file approved by the operator. Discovery alone does
not prove execution. Check MCP `isError` and the result; sanitized tool errors
remain failures. After denial, inspect permissions instead of falling back to
shell, another identity or a broader integration.

The client rejects redirects, has a 55-second deadline and bounds responses
to 1 MiB. It supplies no durable job receipts or caller idempotency keys.
Do not automatically retry ambiguous writes. Revocation cannot undo a provider
write that already started.

## Acceptance evidence required before closing ENG-149

Record sanitized evidence from a real, fresh Codex session:

1. Codex version, full client revision, Node version, approved origin and
   nonsecret configuration diff. Record credential/grant IDs and expiries, not
   values. Confirm unrelated settings are unchanged.
2. Discovery of the exact granted action, schema and resource scope, then one
   successful approved read-only lookup with a bounded result summary.
3. An ungranted action is hidden or denied, and direct unauthorized invocation
   fails. Local tool hiding does not prove server authorization.
4. On disposable acceptance grants/keys only, an operator revokes the grant:
   subsequent invocation must fail, including in the same MCP session. Repeat
   with credential revocation and short expiry. Do not revoke shared keys or
   production grants as a test.
5. Failures stay failures with sanitized output. Record no tokens, private
   result bodies, raw provider errors, cookies or authentication headers.
6. Safe disable/rollback and unaffected native integrations.

Local fixtures and configuration parsing do not satisfy these live gates.
Leave acceptance pending without a dedicated credential, approved resource,
revocation authority and fresh authenticated session. Report implemented,
merged, deployed and verified-live status separately.

## Disable and rollback

Set only `mcp_servers.capykit.enabled = false` and reconnect. Confirm a fresh
session exposes no Capykit tools and unrelated integrations still work. This
does not terminate an already-running provider call or revoke its key. Have
the operator revoke the dedicated key if retiring access, and resolve in-flight
effects before declaring containment. Do not delete shared caller identities.

Restore only the previous Capykit table and pinned client path from a protected
backup, retaining unrelated changes. Removing execution tools returns to
discovery-only mode after reconnect; server-side grants still exist.

## Local catalog and inventory are separate

Without `--remote`, `capykit-mcp` exposes `search_tools`, `get_tool`,
`list_capabilities` and `check_availability`. These inspect declarations, not
hosted grants or provider access. Use a separate integration name if both are
needed. Published-package support is narrower than source support; follow the
README rather than assuming all source commands ship.

Reuse ENG-120's separately tracked host inventory where available; do not build
another registry. Declarations, installed binaries, configured integrations
and verified access are different evidence. Shell/runtime built-ins and other
native plugins remain outside Capykit management. This workflow never rewrites
a running session's tool surface.
