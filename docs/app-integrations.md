# Hosted app integrations

The Apps screen lists the connectors shipped and supported by this deployment.
The first two are GitHub and Google Drive. Activepieces' full catalog is not
installed or implicitly available. The approved mobile design uses a dark theme,
vertical app rows, search, a connected filter, and bottom navigation on phones.

## Available actions

A connected app exposes a vertical list of reviewed read-only actions. Choose an
action, supply its inputs, and run it in Apps. Owners can run actions against their
workspace connections. Members and agents see only actions covered by current,
explicit grants. Google Drive accepts a file or folder link as well as an ID.

| App | Action | Returned fields |
| --- | --- | --- |
| GitHub | Get Issue (Agent) | Number, title and state from an approved repo |
| Google Drive | Get File or Folder | ID, name and MIME type |
| Google Drive | Search Files and Folders | Name matches, with optional folder |
| Google Drive | List files | Names directly inside a folder |

Drive lists return at most 25 results per request. Next 25 results uses the
returned continuation token; there is no automatic full-account crawl. Drive
access permits account-wide metadata reads, including shared files accessible to
the connected account. It does not download file contents or write files.

The action labels and selected input metadata come from pinned Activepieces
packages: `piece-github@0.9.0` and `piece-google-drive@0.11.0`. The checked-in
snapshot is `src/hosted/action-definitions.json`. Capykit's small allowlist adds
strict input contracts, limited response projections and authorization around
those definitions. Search and folder listing use the pinned search action with a
restricted parent-broker query. Activepieces' full catalog, server and enterprise
embedding SDK are not installed. The community license remains in
[LICENSE.activepieces](LICENSE.activepieces).

The shared API is `GET /v1/actions` and
`POST /v1/actions/:id/run` with `{connectionId, input}`. Discovery includes input
schemas and the caller's permitted connection/repository choices. Browser calls
use the existing authenticated session and same-origin CSRF protection. The old
connection-test URLs delegate to this same execution path.

## Grant access and connect an agent

In Access, create an agent with an expiry, save its once-visible key, then grant
specific actions and connections. A key identifies the agent but grants no app
access by itself. GitHub grants also select approved repository IDs. Human
workspace members can receive the same action grants. Grants pin the connection
generation and connector version; reconnecting an account requires new grants.

Only a SHA-256 key hash is stored. Keys and grants require explicit expiration
within one year; the console defaults to 30 days. Rotate key revokes the old key
and preserves the agent's existing grants. Revoke key blocks authentication;
revoke action access blocks that grant. Each call checks current identity,
membership, role, key, grant, connection and repository authority. A bound run
cannot switch to another grant after revocation.

Install Capykit in the agent's environment, set `CAPYKIT_BASE_URL` to the deployed
HTTPS origin and `CAPYKIT_API_KEY` through its private secret configuration, then
launch:

```text
capykit-mcp --remote
```

This stdio bridge exposes `list_actions`, `get_action` and `run_action`, forwarding
to the same API used by the web console. It never receives a GitHub or Google
credential. Redirects are rejected and errors are sanitized. Local registry MCP
keeps its existing four discovery tools and does not execute actions. This is
not the full versioned-capability remote discovery API planned under ENG-124.

## Execution boundary

GitHub installation tokens are restricted to the selected immutable repository
ID and revoked after each invocation. Repository renames are resolved by that ID.
Google refresh credentials remain encrypted on the backend. Reads and returned
results are reauthorized. Metadata-only audits record the actor, action, bound
grant and outcome, without inputs, provider response bodies or credentials.

A child process runs trusted, pinned connector code without host environment or
provider credentials. Nock intercepts the exact request and blocks other HTTP
requests. The parent supplies a fixed provider URL and credential, rejects
redirects, limits responses to 256 KiB and 10 seconds, and returns the verified
response. Child lifetime is 15 seconds, V8 heap is 128 MiB, output is at most
32 KiB, and two children may run per API process. This is a transport boundary for
trusted dependencies, **not a sandbox for user code**.

Published function/skill grants remain separate, bound to their existing immutable
versions and contracts. Direct action grants do not authorize uploaded code.
Uploaded function execution remains ENG-125, including isolated runtime,
durable admission, idempotency, quotas, run history and worker fencing. Direct
action results are synchronous and are not stored as durable function runs.

## Deployment and verification

Back up the database and deployment configuration before applying additive
`008_connector_actions.sql` after migrations 001–007. The API readiness check
requires the action tables. Initialization applies migration008 automatically
for new deployments. Existing deployments must apply it explicitly, then recreate
only app containers. Preserve auth, PostgreSQL, inbox, provider storage,
encryption keys and routes. Rollback may use the prior app image while leaving the
additive tables intact; do not restore the database over subsequent activity.

Tests exercise real PostgreSQL RLS, actual pinned connector code and controlled
provider transport, including tenant isolation, fresh role checks, repository
scoping, revocation, rotation and generation changes. Browser checks exercise
360/390/768/1440px layouts against controlled API responses. These checks do not
prove a real customer's Google consent or provider read; those live acceptance
steps must be recorded separately.

## Google operator setup

This is a one-time platform setup. End users then connect through Google's
account chooser; they never enter client credentials in Capykit.

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   in a dedicated Capykit Google Cloud project. Enable the Google Drive API.
   Configure Branding, Audience and Data Access. While testing, add the Google
   accounts that will connect as test users. The registered scopes are `openid`,
   `email`, and `https://www.googleapis.com/auth/drive.metadata.readonly`.
2. Under Clients, create a **Web application** client named Capykit. Register the
   exact deployed HTTPS callback, including its port. For this preview:

   ```text
   https://srv1379035.tail5c6a78.ts.net:19121/v1/connections/google/callback
   ```

   Download the client JSON when Google shows the secret and store it privately.
   A service account, Desktop client, or Workforce IAM OAuth client cannot
   substitute for this Google Web client. Never reuse another application's
   client or refresh tokens. See Google's
   [client registration instructions](https://support.google.com/cloud/answer/15549257).
3. From a trusted Linux/Unix repository checkout, import the file. Keep the
   source JSON outside the checkout, mode `0600`. The destination directory must
   exist. If configuration already exists, securely back it up first without
   printing its contents.

   ```bash
   CAPYKIT_PUBLIC_BASE_URL=https://srv1379035.tail5c6a78.ts.net:19121 \
   CAPYKIT_GOOGLE_CLIENT_FILE=/private/path/capykit-web-client.json \
   CAPYKIT_GOOGLE_ENV_FILE=/etc/driftward/capykit-google.env \
     node scripts/configure-google-oauth.mjs
   ```

   The importer checks the Web client and exact callback, atomically writes a
   `0600` environment file, and generates a 32-byte encryption key. It prints
   readiness metadata only. Reimporting the same client preserves the encryption
   key; changing clients requires an explicit migration instead of silent
   replacement. Keep a secure backup of the environment file: losing the key
   requires reconnecting accounts. An interrupted import may leave a `.lock`
   file; remove it only after confirming no importer is still running.
4. Compose loads `/etc/driftward/capykit-google.env` if present. Override its path
   with `CAPYKIT_GOOGLE_ENV_FILE`. Never commit or echo credential files. Apply
   migration `006_hosted_app_connections.sql` after migrations 001–005, with the
   usual database backup, if it has not already been applied. Recreate **only**
   the app service using the existing deployment's Compose arguments. Preserve
   PostgreSQL, auth, inbox, provider storage, sign-in configuration and routes.
5. In Apps → Google Drive, select Check availability or reload. Read the scope
   disclosure and select Connect Google Drive. Choose a permitted Google test
   account, approve at Google, and verify the return shows Connected with the
   correct account. Read one known file's metadata through Get File or Folder.
   Configuration readiness alone does not establish that live OAuth works.

OAuth requests `openid email` and `drive.metadata.readonly`. This is account-wide
read-only metadata access, including shared files the account can access; it does
not permit reading file contents or writing files. The UI explicitly discloses
this breadth before consent. Review Google's scope verification requirements before
making the application broadly available.
See [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
and [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

One Drive account is stored per workspace. State is random, single-use, PKCE-bound,
session/principal/workspace-bound and expires in ten minutes. Refresh credentials
use authenticated encryption bound to workspace and connection generation.
Membership and generation are checked again after code exchange and before reads
and results. Expired refresh grants become Reconnect required; transient provider
outages do not silently disconnect an account.

Disconnect removes this workspace's local credentials immediately and fences
in-flight reads. It deliberately does not call Google's project-wide token revoke
endpoint: that would invalidate other workspaces or a newer OAuth exchange for the
same account. The UI links to Google's account permissions for an explicit global
removal. Failed/superseded callback credentials are discarded, never persisted or
revoked project-wide. Other workspaces retain their independently consented access.

## Established connection flow

Use the same interaction documented by
[Zapier](https://help.zapier.com/hc/en-us/articles/8495965163405-How-to-get-started-with-Google-Drive-on-Zapier)
and [n8n](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service):
connect, choose an account at Google, approve Google's permission screen, return
connected. Capykit reuses Google's hosted account chooser and consent UI through
the existing OAuth redirect. A full-page redirect works on mobile without popup
permissions. There is no additional Capykit checkbox or account selector.

The single Connect Google Drive action follows the scope and workspace-owner
disclosure and sends the existing explicit consent flag to the API. Reconnect
required has the same direct action. Cancellation and expired callbacks return
to the Drive detail screen with an explanation and a retry. The selected app is
retained in the URL, including after refresh; OAuth codes and state are removed.

Activepieces' connector packages do not include its hosted connection manager.
Its [connection SDK](https://www.activepieces.com/docs/embedding/embed-connections)
requires initialization through [enterprise embedding](https://www.activepieces.com/docs/embedding/embed-builder).
Do not add that SDK without the corresponding service and license. Reusing a
connection pattern does not permit using another application's OAuth credentials.
Like self-hosted n8n, this deployment still needs its own registered Google client;
that one-time operator task is separate from end-user account connection.

Without dedicated Google configuration, the catalog says Not available yet and
the detail screen explains why, with Check availability to retry after setup.
It exposes no Connect button or client-secret inputs. Operator instructions above
remain the deployment runbook, not a user onboarding form.
Configuration readiness is not proof of successful live OAuth;
a real account callback and read must still be verified. API tests use controlled
provider responses, with real PostgreSQL RLS and real pinned connector code.
