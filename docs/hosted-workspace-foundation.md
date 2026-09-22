# Hosted workspace foundation

The hosted application is separate from the existing CLI/MCP package. This draft
implements the local application and its regression checks; it does not establish
that Railway, Supabase, SMTP, or private Storage have been provisioned.

## Processes

Run `npm ci` and `npm run build` from a checkout before starting either entry point.

- API/web: `npm run start:hosted-api` starts Fastify and serves the built React
  console and its Vite assets from the same origin.
- Worker: `npm run start:hosted-worker` performs one configuration/database
  readiness check, prints its bounded result, and exits unsuccessfully when
  unavailable. It is a worker healthcheck skeleton, not a running job consumer;
  GitHub App access and isolated execution remain in ENG-123 and ENG-125.
- Liveness: `GET /health/live` reports that the API is running.
- Readiness: `GET /health/ready` returns 503 if required configuration, database
  connectivity, or the identity schema is unavailable. It checks schema access
  with the configured runtime role; it does not verify SMTP delivery or provider
  account access. Valid configuration and a readable schema return 200.

## Managed prerequisites

Set these through the service environment, never in committed files:

- `DATABASE_URL`: direct or session-pooled Supabase Postgres connection.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: server-side authentication only.
- `CAPYKIT_PUBLIC_BASE_URL`: exact deployed API/web origin. HTTPS is required;
  loopback HTTP is allowed for local development.
- `CAPYKIT_ALLOWED_CALLBACK_ORIGINS`: optional comma-separated exact origins;
  defaults to the public origin. Origin values cannot contain credentials,
  paths, queries, or fragments. Unsafe browser requests must still originate
  from the public API/web origin.
- `PORT`: optional API port, default 3000.
- `CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG`, `CAPYKIT_BOOTSTRAP_WORKSPACE_NAME`,
  `CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID`, and
  `CAPYKIT_BOOTSTRAP_OWNER_EMAIL`: one-time owner bootstrap inputs.

Disable Supabase signup and pre-create or invite the initial user. Configure
custom SMTP and the approved sender. In the Supabase **Magic Link** email
template, send the six-digit `{{ .Token }}` value instead of a confirmation link,
with the provider's email OTP length set to six digits. The console uses code
entry and server-side verification, following the
[Supabase email OTP flow](https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp).
No access or refresh token is returned to browser JavaScript or stored in browser
storage. Restrict Supabase callback URLs to the deployed allow-list as well.

Before deployment, use a schema owner for migrations and a separate runtime role
without schema ownership or DDL privileges. The current API needs `SELECT` on
`workspaces`, `principals`, `identity_bindings`, and `workspace_memberships` and
schema usage. Bootstrap uses separate credentials permitted to insert/update
those records. Disable browser Data API access to application tables, revoke
access from Supabase's `anon` and `authenticated` roles, and provision private
Storage without public-read policies. These managed grants and policies require
separate deployment verification; the migration does not provision them.

## Database and bootstrap

1. Take a database backup and stop application writers before a migration.
2. Apply `scripts/migrations/001_hosted_workspace_identity.sql` with the schema
   owner, using `psql --single-transaction --set ON_ERROR_STOP=1 --file` and the
   migration path. Supply the database connection through managed configuration.
   A failure rolls back the migration transaction; correct it before retrying.
3. Run `node scripts/bootstrap-hosted-owner.mjs` with the bootstrap variables and
   separate bootstrap credentials. Confirm the Supabase user ID belongs to the
   intended pre-created user; bootstrap is an operator trust boundary.
4. Rerun bootstrap and confirm it returns the same workspace/principal IDs.
   It will not reactivate a disabled workspace, principal, or membership, or move
   an existing identity into a different workspace. A failed bootstrap rolls back
   its transaction.
5. Start API and worker with the runtime database role. Both database connection
   establishment and queries have five-second deadlines; API pools have at most
   five connections.

The migration can be reapplied. For recovery after an already committed schema
change, stop writers, restore the pre-migration backup into a separate database,
and verify bootstrap and readiness there before switching configuration. Do not
run a destructive table-drop rollback against a database with application data.

Downstream workspace-owned tables must use compound `(workspace_id, id)` keys and
compound foreign keys. The included membership, principal-creator, and publication
constraints reject cross-workspace substitutions in PostgreSQL.

## Browser authentication and request safety

The console requests a code with `POST /v1/auth/otp`, then submits email and code
to `POST /v1/auth/verify`. The provider request disables account creation; invited
and unknown emails receive the same accepted response. Invalid or expired codes
cannot establish a session. Successful provider verification is followed by a
fresh identity-binding, active-principal, active-workspace, and active-membership
lookup before the API issues cookies.

`GET /v1/me` repeats server-side token verification and the current database
lookup. It derives workspace/role from stored membership and ignores client
identity assertions. The console displays that identity/workspace and supports
logout and session-expiry recovery. Sessions expire with the provider access
token; automatic refresh is not implemented, so an expired session requires a
new email code.

Session cookies are HttpOnly, Secure on HTTPS, SameSite=Strict, and scoped to `/`.
A readable random CSRF cookie supplies the `x-csrf-token` header for browser
mutations. Cookie-authenticated writes, including session renewal, require the
same origin and matching token; bearer-only requests do not use cookie authority.
Logout clears both cookies. Bearer authentication currently verifies Supabase
identity; Capykit agent-key authentication belongs to ENG-124.

Application errors return bounded codes and generated request IDs. Request
logging is disabled, responses are not cached, and raw database/provider error
messages, cookies, authorization headers, OTP codes, and token responses are not
returned in application error responses.

## Verification

Run `npm run factory:verify` for repository checks, HTTP session/CSRF/error tests,
provider-boundary tests, and packed-package CLI/MCP/hosted asset/worker smoke.

To include actual PostgreSQL migration, bootstrap, persistence, revocation, and
foreign-key tests, set `CAPYKIT_TEST_POSTGRES_URL` to a **disposable test database**
with permission to create schemas and extensions, then run the same command.
Each test run creates and drops its own randomly named schema. Without that
variable the five PostgreSQL tests are explicitly skipped; pure HTTP tests use
fake provider/database boundaries and do not prove live SMTP or Supabase access.

Before hosted rollout, separately verify live invited-user email delivery,
provider verification, managed database privileges, browser Data API isolation,
private Storage policies, Railway deployment, and backup restoration.
