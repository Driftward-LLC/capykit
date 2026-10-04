# Factory integration README

Capykit is the tooling gateway. Factory owns agents, executors, jobs, retries,
leases and execution receipts. Capykit owns connected app credentials, tool
discovery, access grants and individual tool calls. Do not move agent lifecycle
or Factory orchestration into Capykit.

```text
Factory job -> Factory executor -> Capykit -> connected app
```

## Current status

As of 2026-10-04, hosted connector actions and their authenticated REST API are
deployed. The stdio MCP client can call that API. Personal accounts are private
by default; their owners explicitly grant individual actions to callers.
Capykit manages provider OAuth registrations centrally.

Factory's Hermes runtime passed its health checks, but Capykit was not registered
in its MCP configuration. No Factory integration has been deployed by this
documentation change. An arbitrary uploaded function or whole Factory job
cannot yet be invoked through this gateway.

The current implementation calls API credentials **agent keys** and the Access
screen says **Create agent and key**. These are legacy names for the gateway's
caller principal and credential. They do not provision an executor or manage
an agent lifecycle. The intended terminology is API clients and access
credentials; that UI/API naming change has not shipped. Do not invent a
`/v1/clients` API or a new authentication scheme.

## Connect the executor

1. Have the operator issue a dedicated, expiring Factory client credential using
   the existing Access screen, and grant one approved action on one connection.
   A credential alone grants no provider access. Use a read-only action first.
2. Store only that Capykit credential in the executor's protected configuration.
   Keep provider credentials in Capykit. Hatchet dispatch/bridge workers must
   receive neither the Capykit credential nor provider credentials.
3. Install a pinned Capykit client build that includes `--remote` in the executor.
   Do not assume the published npm `latest` contains the hosted integration.
   The deployed feature source is commit
   `eadda266ba9990927c30d84b272bc42b6c6f8573`; the integration branch is
   `codex/eng-123-github-connections`.
4. Register the existing stdio client in the executor's native MCP configuration.
   Factory's Hermes executor is the integration point. Supply its environment
   from protected runtime configuration, never inline secret command arguments.

Use Node.js 22 or newer. In a checkout of the pinned source, `npm ci` followed
by `npm run build` produces the client. The MCP launch command is:

```bash
node /absolute/path/to/capykit/dist/mcp.js --remote
```

Required environment variables:

| Variable | Meaning |
| --- | --- |
| `CAPYKIT_BASE_URL` | HTTPS deployment origin, with no path or query |
| `CAPYKIT_API_KEY` | Operator-issued Factory client credential |

Current deployment origins:

- Public: `https://srv1379035.tail5c6a78.ts.net:10000`
- Private tailnet: `https://srv1379035.tail5c6a78.ts.net:19121`

Verify DNS, TLS and network reachability from the actual executor container.
A container does not inherit the host's tailnet identity. API callers use bearer
credentials, not browser sign-in codes or Tailscale user-header impersonation.
Never disable certificate verification to make the connection work.

`--remote` starts a local stdio MCP process that calls Capykit's REST API. It is
not a hosted `/mcp` endpoint. Local catalog mode without `--remote` exposes a
different, read-only discovery surface.

## Discover and invoke tools

The personal connection MCP tools are:

| Tool | Input | Result |
| --- | --- | --- |
| `list_connections` | None | Caller-visible connections, no credentials |
| `list_connection_actions` | `connectionId` | Authorized actions and schemas |
| `run_connection_action` | `connectionId`, `action`, `input` | Action result |

Select connection/action IDs from discovery; do not infer permission from the
766-app catalog. Only granted actions appear to a client. Sharing currently
supports reviewed versions of text concatenation, GitHub issue lookup and
Google Drive file lookup. Other owner-visible actions are not necessarily
delegatable. Existing workspace GitHub/Drive read tools remain available through
`list_actions`, `get_action` and `run_action`.

An executor may use REST directly instead of MCP. Send
`Authorization: Bearer <credential>` over HTTPS, with JSON for POST requests:

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/v1/connections/personal` | None |
| GET | `/v1/connections/personal/:id/actions` | None |
| POST | `/v1/connections/personal/:id/actions/:action/fields` | Input wrapper |
| POST | `/v1/connections/personal/:id/actions/:action/run` | Input wrapper |

Both POST bodies wrap the action inputs: `{"input":{}}`. Populate that inner
object from the discovered schema; the empty object requests initial fields.

The fields endpoint resolves supported account-dependent input choices. Supply
literal inputs only; template expressions and credential selectors are rejected.
The MCP client returns `isError: true` for a failed tool call; the executor must
check it rather than treating any MCP response as success.

## Execution and retry boundaries

Capykit checks current permission before execution and before returning results.
Revocation or disconnect blocks subsequent calls and can withhold an in-flight
result. It cannot undo a provider write that already started.

Calls are synchronous. The MCP client has a 55-second request deadline and a
1 MiB response limit. The current connector preview permits two concurrent
temporary action requests per API process and one engine worker. It is not a
durable job queue for Factory.

There is no caller-supplied idempotency key or Factory job receipt contract on
the run endpoint. Do not automatically retry an ambiguous write timeout. Before
using writes such as PR creation, implement and review action authority,
duplicate-effect protection and Factory receipt handling. Record bounded tool
metadata in Factory; keep credentials, raw provider errors and private outputs
out of control-plane logs. A request body or job ID never grants authority.

## First acceptance check

1. Discover only the granted connection and read-only action from the executor.
2. Run that action against an operator-approved test resource.
3. Revoke the grant and confirm the same call is denied.
4. Revoke the client credential and confirm authentication fails.
5. Confirm Factory workers hold no gateway/provider credentials and the existing
   execution fences, receipts and verification remain intact.

Report implemented, merged, deployed and verified live separately. Real Factory
execution and changes to its production runtime still follow Factory's reviewed
activation procedure.

## Source of truth

- [MCP implementation](../src/mcp/remote.ts)
- [REST routes](../src/hosted/server.ts)
- [Personal permission checks](../src/hosted/personal-connections.ts)
- [Personal connection operator runbook](PERSONAL-CONNECTIONS.md)
- Factory's `AGENTS.md`, `deploy/EXECUTOR.md` and execution-worker READMEs define
  its credential and runtime boundaries.
