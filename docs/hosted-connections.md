# Hosted GitHub connections

The Connections tab lets an active human workspace owner authorize a dedicated
GitHub App, select repositories, and explicitly consent to future delegated use.
Publishing a capability or connecting a repository creates no execution grant.
Recipient grants and execution remain ENG-124 and ENG-125.

## Register the pilot App

Use a dedicated private App owned by the account containing the pilot repository.
For `Driftward-LLC/capykit`, register under the Driftward-LLC organization. Its
authorized App manager must perform registration; existing Factory or Hermes
credentials are not Capykit credentials.

In GitHub's **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Setting | Value |
| --- | --- |
| Homepage | The private HTTPS Capykit origin |
| Callback URL | `APP_ORIGIN/v1/connections/github/callback` |
| Setup URL | `APP_ORIGIN/v1/connections/github/setup` |
| Expire user authorization tokens | Enabled |
| Request user authorization during installation | Disabled |
| Device flow | Disabled |
| Repository permissions | Issues: read; Metadata: read; all others: no access |
| Organization and account permissions | No access |
| Installation visibility | Only this account for the private pilot |
| Webhook | Active; public HTTPS URL ending in `/v1/webhooks/github` |
| Webhook secret | A separate random secret of at least 32 characters |
| SSL verification | Enabled |
| Additional event subscriptions | None required |

Install with **Only select repositories**, choosing the pilot repository. The
backend rejects installations with all-repository access or broader permissions.
Discovery is limited to 20 installations and 500 repositories in total. Known
ineligible installations are skipped; excess inventory requires a smaller pilot.
The App receives installation lifecycle events automatically. It does not need
issue-content event subscriptions. See GitHub's
[registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
and [webhook event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Manual registration needs no manifest-conversion callback. Capykit's callback is
the workspace OAuth flow, not a GitHub App registration handshake.

## Protected backend configuration

Generate a private key and client secret in the App settings. Compose optionally
loads `/etc/driftward/capykit-github.env`, or the path selected by
`CAPYKIT_GITHUB_ENV_FILE`. Keep that file outside source control, mode `0600`,
inside a private directory. Supply all of these together:

| Variable | Value |
| --- | --- |
| `CAPYKIT_GITHUB_APP_ID` | Numeric App ID |
| `CAPYKIT_GITHUB_APP_SLUG` | App slug |
| `CAPYKIT_GITHUB_CLIENT_ID` | App OAuth client ID |
| `CAPYKIT_GITHUB_CLIENT_SECRET` | App client secret |
| `CAPYKIT_GITHUB_PRIVATE_KEY` | Full RSA PEM, at least 2048 bits |
| `CAPYKIT_GITHUB_WEBHOOK_SECRET` | Same secret configured on GitHub |
| `CONNECT_STATE_ENCRYPTION_KEY` | 32 fresh random bytes, canonical base64 |
| `CONNECT_STATE_ENCRYPTION_KEY_VERSION` | Explicit label, such as `v1` |

Compose env files support quoted multiline values for the PEM. Alternatively, set
`CAPYKIT_GITHUB_PRIVATE_KEY_FILE` to a separately mounted read-only PEM readable
by the container's `node` user. Set exactly one private-key option; the standard
Compose file does not mount a PEM automatically. Never print expanded
Compose configuration or paste values into chat, issues, logs, or artifacts.

The callback derives from `CAPYKIT_PUBLIC_BASE_URL`. An optional
`CAPYKIT_GITHUB_CALLBACK_URL` must match that exact callback. An absent GitHub
configuration leaves the library and connection metadata available. Partial or
invalid configuration stops startup with a sanitized error.

## Private application and public webhook

The application remains on its private HTTPS origin. Browser redirects can use
that private origin because the signed-in user's browser can reach it. GitHub's
servers need a separate public HTTPS webhook address.

Compose binds the application to loopback port 19121 and a restricted webhook
listener to loopback port 19123. Override these with `CAPYKIT_HTTP_PORT` and
`CAPYKIT_WEBHOOK_HTTP_PORT`. The latter listener exposes only the exact
`POST /v1/webhooks/github` path; console, login, health, and workspace routes
return 404. It preserves raw signed bytes, strips identity/forwarding headers,
limits bodies to 1 MiB, and admits at most four concurrent requests. In standalone
Node deployments, set `CAPYKIT_WEBHOOK_PORT` to enable that separate listener.

Terminate TLS at a dedicated ingress forwarding to this listener. Do not point
public ingress at the normal API port. Preserve any existing unrelated routes.
The receiver requires a valid HMAC-SHA256 signature and bounded GitHub event and
delivery headers before touching connection state. Invalid signatures receive
401; valid deliveries receive 202. Duplicate lifecycle deliveries are ignored.

Operational checks must include an unsigned request returning 401 once configured,
404 for private paths at the public origin, and a real GitHub test delivery.
GitHub's App settings show failed deliveries and allow redelivery; this slice
does not add external alerting. Request logging is disabled on both listeners.

## Owner flow and authority

1. Open **Connections**, install the App if needed, then authorize GitHub.
2. Return to Capykit and review the verified installation and repositories where
   the current GitHub user has administrator permission.
3. Select exact repositories and accept the delegation explanation. Capykit
   rechecks current user, App, account, installation, and administrator access
   before committing consent.
4. Reconnect to approve changed selections. Reconnection pauses existing use
   until confirmation. Newly added GitHub repositories are never auto-approved.
5. Disconnect to revoke local authority immediately. Uninstalling the App on
   GitHub is a separate action linked from the connection detail.

An installation binds to one workspace, including after disconnect. The pilot
does not provide installation transfer between workspaces. A reconnect must
preserve the bound installation and account. Future explicitly granted humans
or agents can use the App's repository access without their own GitHub access;
that is why repository selection and consent are explicit.

The OAuth GET serves a static page without session-dependent work. At module
load, the browser removes code/state from the URL before fetching identity. It
then POSTs the continuation with the existing strict cookie and CSRF token.
Missing or changed sessions require a new setup. State is single-use, bound to
session and workspace, and paired with S256 PKCE. Authorization and confirmation
each expire after ten minutes. Temporary credentials use AES-256-GCM with fresh
nonces, versioned keys, and workspace/session/setup authenticated context.

Completion, cancellation, failure, disconnect, and cleanup discard local setup
credentials before remote revocation. A remote cleanup failure records only a
safe diagnostic. Remove an orphaned user authorization through GitHub's
**Settings → Applications → Authorized GitHub Apps**. User deauthorization does
not revoke an already confirmed installation connection. Uninstall the App if
installation authority must also be removed.

Signed suspension, deletion, and repository removal events invalidate affected
authority. Backend provider denial also fails closed. Installation-scoped locks
and generation checks fence concurrent confirmation and disconnect. Tokens are
minted only by the internal preauthorized runtime seam, for exact repository IDs
and Issues/Metadata read access, held in memory, and revoked in `finally`.
ENG-124/125 must authorize the caller's grant and invoke the supplied access check
before each provider operation. There is no browser execution shortcut. Sent
provider requests and already delivered results cannot be recalled.

## Maintenance, upgrade, and verification

Migration `004_hosted_connections.sql` adds metadata, encrypted setup state,
repository selections, non-content audit records, and webhook fences. Existing
identity tables remain read-only to the runtime. Owner operations use current
database membership; foreign workspace IDs return 404 and forbidden known IDs
return 403. Only the backend's transaction-scoped system context handles
webhooks, maintenance, and the internal runtime seam.

For an existing installation, take and restore-test a protected backup, apply
only migration 004 as the schema owner in a transaction with `ON_ERROR_STOP=1`,
then deploy the application. Fresh volumes apply migrations 001–004 atomically.
Keep the previous image and preserve added tables for application rollback.

Run bounded maintenance using the same restricted database login and optional
GitHub configuration as the app:

```sh
docker compose --env-file /path/to/protected-config -p capykit-staging \
  exec -T app node scripts/cleanup-hosted-connections.mjs 50
```

Each call removes at most 50 expired setups and 50 records from each 30-day audit
and delivery retention set. Repeat batches until counts are zero. Expiry denies
access immediately; physical cleanup is an operator step in this slice. Periodic
worker scheduling belongs to ENG-125. Losing or rotating the encryption key
requires restarting affected pending setups; active connections store no user
tokens. Key loss prevents remote revocation of unreadable temporary credentials,
so remove those orphaned authorizations on GitHub. Backups retain historical
encrypted data until separately expired; reconcile revocations before a restore.

Set `CAPYKIT_TEST_POSTGRES_URL` to a disposable database and run `npm run check`.
Provider mocks prove request scoping and error behavior; real PostgreSQL/HTTP
tests prove transaction, identity, RLS, replay, and lifecycle behavior. Browser
tests with mocked APIs prove the UI, not GitHub acceptance. ENG-123's real-provider
verification remains open until a registered App completes selected-repository
confirmation, a narrow issue read, signed lifecycle handling, disconnect, and
recovery. An unconfigured screen or a mock success does not satisfy that check.
