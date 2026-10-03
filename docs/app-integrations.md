# Hosted app integrations

The Apps screen lists the connectors shipped and supported by this deployment.
The first two are GitHub and Google Drive. Activepieces' full catalog is not
installed or implicitly available. The approved mobile design uses a dark theme,
vertical app rows, search, a connected filter, and bottom navigation on phones.

## Connection tests

Workspace owners can explicitly read one issue from an approved GitHub repository,
or read one Drive file's metadata using the connected Google account. These tests
run pinned Activepieces actions (`piece-github@0.9.0/get_issue_ai` and
`piece-google-drive@0.11.0/drive_get_file`), retaining the community license in
[LICENSE.activepieces](LICENSE.activepieces). No Activepieces server or enterprise
embedding SDK is used.

The API verifies current identity/membership/owner authority, then uses the current
connection generation. GitHub installation tokens are restricted to the selected
repository ID and revoked after each test. A renamed repository is resolved by its
immutable ID. Each provider read and the returned result are reauthorized. Tests
are audited without provider response bodies, file IDs or credentials.

A child process runs only these two trusted, pinned actions. It receives no host
environment or provider credentials. Nock intercepts the exact action request,
blocks other HTTP requests, and relays it to the parent. The parent supplies a
fixed provider URL and credential, rejects redirects, limits responses to 256 KiB
and 10 seconds, and sends the verified response back. Only projected issue/file
fields return to the browser. Child lifetime is 15 seconds, V8 heap is 128 MiB,
output is at most 32 KiB, and two children may run per API process. This is a
transport boundary for trusted dependencies, **not a sandbox for user code**.

Published function grants remain bound to their existing immutable version and
`github.issues.list.v1` contract. They do not authorize these owner connection
tests. Uploaded function execution remains ENG-125, including its isolated
runtime, durable admission, idempotency, quotas and worker fencing requirements.
Drive user/agent grants and arbitrary Activepieces actions are not enabled here.

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
   correct account. Read one known file's metadata through the connection test.
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
