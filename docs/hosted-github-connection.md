# Hosted GitHub connection provisioning

Capykit-owned GitHub OAuth registration is an operator action, not an
end-user setup task. Personal GitHub connections stay pending until the
platform operator registers and verifies the centrally managed provider.
Customers should never be asked to create developer credentials.

## OAuth app registration

Create a dedicated Capykit-owned GitHub OAuth App or GitHub App OAuth identity.
Do not reuse Factory, Driftward Hermes, personal Hermes, root GitHub auth,
browser sessions, installation tokens, or provider tokens.

Use these nonsecret settings for the hosted deployment:

- Application name: `Capykit` plus the environment, for example
  `Capykit Staging`.
- Homepage URL: exact `CAPYKIT_PUBLIC_BASE_URL` origin.
- Authorization callback URL:
  `${CAPYKIT_PUBLIC_BASE_URL}/v1/connections/github/callback`.
- Webhook URL: leave unset for the read-only canary.
- GitHub App permissions: if using a GitHub App, request only metadata read and
  issues read for the reviewed repositories.
- OAuth scopes: if using an OAuth App, request only the scopes required for the
  reviewed read action.

If organization-owner interaction is required, record the pending operator step
with these settings and stop. Do not fabricate a client ID, client secret,
installation ID, consent result, or verified provider state.

## Protected runtime configuration

Store the provider client ID, client secret, redirect URI, and any GitHub App
private key or webhook secret only in the deployment secret store used by the
Capykit API process. Keep secret values out of Git, Linear, Factory prompts,
logs, shell history, worker containers that do not need them, and browser assets.
Preserve the existing Google OAuth registration and connector configuration.

Before changing a live deployment:

1. Back up PostgreSQL with `pg_dump -Fc` into a protected operator directory.
2. Save role globals with `pg_dumpall --globals-only` in the same protected
   location.
3. Restore-test the backup into a disposable database.
4. Record the current image tag and source revision.
5. Apply only the new nonsecret environment names and provider configuration.

Health is not proven by configuration alone. After deployment, verify
`/health/ready`, a browser sign-in, the GitHub connection setup flow, and a
sanitized provider callback result. Keep raw provider errors and credentials out
of evidence.

## Setup-pending state

When GitHub is not centrally configured, the UI must say that Capykit is waiting
on platform-operator setup. It must not tell the user to create OAuth developer
credentials. Once configured, the UI may ask the user to grant their own account
and repository consent through the centrally managed app.

## Codex read-only canary

The ENG-150 canary is complete only after a real hosted connection and fresh
Codex session prove all of the following against `Driftward-LLC/capykit` issue
`#16`:

1. An approved Driftward GitHub account is connected through the Capykit-owned
   provider.
2. A dedicated expiring Codex caller is created.
3. Only the reviewed issue-read action and repository are granted.
4. Fresh Codex discovery records the exact schema and resource scope.
5. The bounded issue-read result succeeds with sanitized evidence.
6. An ungranted action is hidden or denied by the server.
7. A disposable grant and caller credential are revoked, and subsequent calls
   fail in the same and a fresh session.

Never revoke shared production authority as a test. Fixture tests, local schema
checks, and setup readiness are useful but do not satisfy live acceptance.

## Rollback and recovery

To disable the provider without data loss, remove only the GitHub provider
runtime configuration and restart the API. Existing connection records should
remain unavailable rather than being deleted. If a narrow service recreation is
needed, recreate only the Capykit API service from the recorded image and the
protected configuration; preserve PostgreSQL volumes and existing Google OAuth
settings. Restore a database backup only after reconciling revocations so old
connection state is not accidentally re-enabled.
