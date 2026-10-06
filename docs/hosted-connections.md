# Hosted GitHub connections

The Connections tab lets an active human workspace owner authorize a dedicated
GitHub App, select repositories, and explicitly consent to future delegated use.
Publishing a capability or connecting a repository creates no execution grant.
[User grants](hosted-access.md) are managed in Access. Agent credentials and
execution remain ENG-124 and ENG-125.

## Set up GitHub inside Capykit

For a new deployment, the configured platform operator can choose **Connections
→ Set up GitHub**. GitHub asks that organization's App administrator to approve
the registration. The browser returns to Capykit, which exchanges the temporary
code on the server, checks the App identity, permissions and webhook settings,
and saves the credentials without exposing them to the browser. Then install
the App on selected repositories and complete the existing authorization flow.

Enable this bootstrap with these nonsecret deployment settings:

| Variable | Value |
| --- | --- |
| `CAPYKIT_GITHUB_SETUP_WORKSPACE_ID` | Existing operator workspace UUID |
| `CAPYKIT_GITHUB_SETUP_PRINCIPAL_ID` | Existing operator human principal UUID |
| `CAPYKIT_GITHUB_SETUP_ORGANIZATION` | GitHub organization login |
| `CAPYKIT_GITHUB_WEBHOOK_URL` | Public HTTPS webhook URL described below |
| `CAPYKIT_GITHUB_CONFIG_FILE` | Absolute private configuration file path |

Compose sets the last value to `/var/lib/capykit/providers/github.json` and
mounts the app-only `provider-config` named volume. The image creates its
directory as the runtime user with mode `0700`; the complete configuration file
uses mode `0600`. This storage requires Unix ownership and permissions; use the
Linux container on Windows hosts. Treat this volume as secret storage: it includes
the App key,
client/webhook secrets and the temporary-state encryption key. Back it up to
protected storage with the database, and preserve it during image upgrades.
Manual environment credentials and a stored configuration cannot coexist;
startup rejects conflicts or corrupt stored credentials instead of enabling
fresh registration over them. The API and cleanup command use the same loader.

Only the exact configured operator, with current active human owner membership,
can initiate or complete registration. Ordinary workspace ownership is not
platform authority. Registration state is bound to that authenticated session,
single-use and valid for ten minutes. This single-process pilot keeps at most
one pending registration in memory; another start or an app restart invalidates
the previous attempt. Once configuration is saved, bootstrap is disabled.

The registration callback is `/v1/provider-setup/github/callback`, distinct
from the repository authorization callback. Its static page strips code/state
before identity requests and completes through a CSRF-protected same-origin
POST. Only a public manifest leaves the browser. The
[GitHub manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
creates the private App with Issues-read and Metadata-read access.

If GitHub creates the App but completion fails, Capykit does not activate it.
Restart setup from Connections. An organization App administrator may need to
remove the incomplete registration in GitHub's developer settings. An expired
Capykit session also requires signing in and starting setup again. Successful
registration does not itself connect repositories or grant execution access.
If a storage error happened after the configuration file was published, preserve
that file and restart the app first; startup can recover the saved configuration.

## Connect repositories and recover setup

The console guides the owner through GitHub verification and workspace approval.
Choose **Continue with GitHub**, authorize the account, then return to choose
repositories and approve access for this workspace. App installation help is
available when needed; registration alone does not complete a connection. In
GitHub installation settings, use **Only select repositories** and choose
repositories where you have administrator access.

During the return from GitHub, the console checks the existing session without
showing sign-in inputs. An unavailable session check offers a retry; a confirmed
missing session requires sign-in and a new authorization. The verification step
keeps progress visible until the repository review is ready.

An installation covering **All repositories** is not eligible for this preview.
If this is why discovery has no candidates, authorization returns the safe
`GITHUB_SELECTED_REPOSITORIES_REQUIRED` error instead of an unexplained empty
picker. Temporary authorization credentials are revoked and discarded on that
failure. Eligible selected-repository installations still work when another
installation is ineligible; no access is broadened to resolve the error.

Empty discovery shows recovery actions instead of a disabled account picker and
confirmation form. Use **Manage GitHub access** to correct the installation, then
**Continue with GitHub** to run a fresh authorization on the same pending connection.
An unfinished connection is labeled **Setup unfinished**; **Finish setup** uses
the same primary GitHub action. The normal start action also reuses a sole unfinished
connection. A refresh only reloads saved connection
status and does not rediscover GitHub repositories. A single eligible GitHub
account is selected automatically, but repositories and delegation consent still
require explicit selection before confirmation. Selection instructions precede
the repository list, with a selected count and permission summary. Recovery
controls remain available under **Missing a repository?** during review.

When several unfinished connections exist, choose one before resuming instead
of creating another pending record. Expired repository review offers **Continue
with GitHub** for a fresh authorization. Canceling an already removed or
expired setup clears the stale form without treating a missing setup as a new
authorization. Reconnecting an approved connection still requires the warning
that its existing access will pause until confirmation.

## Manual registration alternative

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

Manual registration needs no manifest-conversion callback; its callback URL
remains the workspace OAuth flow.

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

1. Open **Connections**, set up GitHub if offered, install the App on selected
   repositories, then authorize GitHub.
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
The in-app registration upgrade needs no further schema migration. Preserve the
new provider configuration volume even when rolling back; images predating its
loader cannot use registered credentials until the new image is restored or an
operator securely configures the manual environment alternative.

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
To run the console regression checks after building, use an existing Playwright
installation with Chromium installed:

```sh
CAPYKIT_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/test-console-flow.mjs
```

This standalone harness intercepts every browser request with test fixtures. It
checks session loading and retry, callback ownership, connection recovery,
explicit repository selection and consent, keyboard focus, and mobile layout.
It reads `dist/console` by default and writes screenshots and a JSON report under
the system temporary directory. `CAPYKIT_CONSOLE_DIR` and
`CAPYKIT_BROWSER_ARTIFACT_PREFIX` override those paths.

Provider mocks prove request scoping and error behavior; real PostgreSQL/HTTP
tests prove transaction, identity, RLS, replay, and lifecycle behavior. Browser
tests with mocked APIs prove the UI, not GitHub acceptance. ENG-123's real-provider
verification remains open until a registered App completes selected-repository
confirmation, a narrow issue read, signed lifecycle handling, disconnect, and
recovery. An unconfigured screen or a mock success does not satisfy that check.
