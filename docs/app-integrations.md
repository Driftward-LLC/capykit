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

1. In a dedicated Capykit Google Cloud project, enable the Drive API and configure
   an OAuth consent screen. Add test users while the OAuth application is in
   testing. Configure a Web application client with the exact redirect URI:
   `https://YOUR-CAPYKIT-ORIGIN/v1/connections/google/callback` (include any port).
2. Put `CAPYKIT_GOOGLE_CLIENT_ID`, `CAPYKIT_GOOGLE_CLIENT_SECRET`, and
   `CAPYKIT_GOOGLE_ENCRYPTION_KEY` in a private operator environment file. Generate
   the encryption key as 32 random bytes encoded in canonical base64. Keep a secure
   backup; changing or losing it requires reconnecting existing accounts.
3. Compose loads `/etc/driftward/capykit-google.env` if present. Override its path
   with `CAPYKIT_GOOGLE_ENV_FILE`. Never commit this file, echo its values, or reuse
   another application's client or refresh tokens.
4. Apply migration `006_hosted_app_connections.sql` after migrations 001–005, with
   the usual database backup. Recreate only the app service after adding the file.
5. In Apps → Google Drive, review the scope, select Continue with Google, and use a
   dedicated test account to verify the callback and a known file ID.

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

Without dedicated Google configuration, the catalog says Setup needed and exposes
no Connect button. Configuration readiness is not proof of successful live OAuth;
a real account callback and read must still be verified. API tests use controlled
provider responses, with real PostgreSQL RLS and real pinned connector code.
