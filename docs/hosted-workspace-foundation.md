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
New free-tier projects created from June 3, 2026 cannot customize templates with
Supabase's default email provider. The code-entry flow therefore requires custom
SMTP, or a plan that permits template customization; see
[Supabase's template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

Before deployment, use a schema owner for migrations and a separate runtime login
without schema ownership, role management, replication, or RLS-bypass privileges.
Migration `002_hosted_database_access.sql` enables RLS on all five application
tables, revokes table privileges from `PUBLIC` and existing Supabase Data API
roles, and creates a `capykit_runtime` NOLOGIN role. That role has schema usage
and `SELECT` policies only for the four identity tables. It cannot write
application data or read the future capability-publication table. It also removes
schema creation rights from `PUBLIC`; use a dedicated Capykit database/schema.

Create the managed application login separately, grant it `capykit_runtime`, and
use its connection URL for the API. Give it `INHERIT` but no elevated role
attributes or memberships. Set its search path to the application schema and
Supabase's `extensions` schema if `citext` is installed there. Bootstrap uses the
schema-owner connection only during setup. Do not store schema-owner credentials
on Railway. Disable the Supabase Data API for this dedicated project as an
additional boundary; Auth and Storage do not require it. Provision a private
Storage bucket without public-read policies before the artifact feature is
enabled. The current foundation does not read or write Storage objects.

## Database and bootstrap

1. Take a database backup and stop application writers before a migration.
2. Apply `scripts/migrations/001_hosted_workspace_identity.sql` followed by
   `scripts/migrations/002_hosted_database_access.sql` with the schema owner in
   **one transaction**, using `psql --single-transaction --set ON_ERROR_STOP=1`
   and one `--file` argument for each migration in that order. Supply the database
   connection through managed configuration. A failure rolls back the transaction;
   correct it before retrying. Keep both migrations together so tables are never
   committed without their access controls.
3. Run `node scripts/bootstrap-hosted-owner.mjs` with the bootstrap variables and
   separate bootstrap credentials. Confirm the Supabase user ID belongs to the
   intended pre-created user; bootstrap is an operator trust boundary.
4. Rerun bootstrap and confirm it returns the same workspace/principal IDs.
   It will not reactivate a disabled workspace, principal, or membership, or move
   an existing identity into a different workspace. A failed bootstrap rolls back
   its transaction.
5. Start the API with the runtime database role. Both database connection
   establishment and queries have five-second deadlines; API pools have at most
   five connections.

The migration can be reapplied. For recovery after an already committed schema
change, stop writers, restore the pre-migration backup into a separate database,
and verify bootstrap and readiness there before switching configuration. Do not
run a destructive table-drop rollback against a database with application data.

Downstream workspace-owned tables must use compound `(workspace_id, id)` keys and
compound foreign keys. The included membership, principal-creator, and publication
constraints reject cross-workspace substitutions in PostgreSQL.

## Railway staging

`railway.json` builds the application, starts the same-origin API/web process,
and requires `/health/ready` before routing traffic. Create one service in an
explicit staging environment, with `RAILPACK_NODE_VERSION=22`,
`RAILPACK_NODE_NPM_INSTALL=npm ci --include=dev` for a locked dependency install,
and `RAILPACK_NO_SPA=1` so Vite detection does not replace the API with a static
server. Use the service's HTTPS domain as `CAPYKIT_PUBLIC_BASE_URL`, Supabase's
site URL, and its exact redirect allow-list. Railway supplies `PORT`; the API
binds `0.0.0.0`.

Apply migrations and bootstrap through a separate privileged operator session
before deploying the API with the scoped runtime connection. Do not use an API
pre-deploy command for schema-owner tasks or deploy the one-shot worker as an
always-running service. Validate root HTML, its assets, `/health/live`, and
`/health/ready`, then verify real email-code login, `/v1/me`, logout, inactive
membership rejection, and anonymous Data API denial. A green readiness check
alone does not prove SMTP delivery or private Storage isolation.

Deployment configuration follows Railway's
[configuration reference](https://docs.railway.com/config-as-code/reference) and
[Railpack Node.js behavior](https://railpack.com/languages/node). Database access
uses both grants and RLS as described in
[Supabase's RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security).

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
with permission to create schemas, extensions, and roles, then run the same
command. Each test run creates and drops its own randomly named schema and test
roles. Without that variable the PostgreSQL tests are explicitly skipped; pure
HTTP tests use fake provider/database boundaries and do not prove live SMTP or
Supabase access.

Before hosted rollout, separately verify live invited-user email delivery,
provider verification, managed database privileges, browser Data API isolation,
private Storage policies, Railway deployment, and backup restoration.
