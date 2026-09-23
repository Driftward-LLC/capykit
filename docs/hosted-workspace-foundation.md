# Hosted workspace foundation

Capykit runs the API and React console in one Node process. The portable staging
stack uses Docker Compose, ordinary PostgreSQL, standalone GoTrue authentication,
and a private Mailpit test inbox. It requires no Railway or Supabase account.
GoTrue is the open-source authentication service maintained by Supabase; it runs
inside this deployment, rather than depending on their hosted platform.

This foundation provides invited-user sign-in and durable workspace identity.
The [capability library](hosted-capabilities.md) adds complete skill/function
artifacts and immutable versions. Connections, grants, execution, and run history
remain the later ENG-123 through ENG-126 milestones. The worker executable is a
one-shot readiness check, not an execution queue consumer.

## Portable deployment

Build and run the same `Dockerfile.hosted` and `compose.yaml` on a Docker host.
Infrastructure changes should alter configuration and ingress, not application
code. The existing MCP container build remains a separate package artifact.

Create a protected configuration file outside the repository with these values:

- `CAPYKIT_PUBLIC_BASE_URL`: the exact HTTPS application origin. Loopback HTTP is
  allowed for local development, for example `http://localhost:19121`.
- `POSTGRES_PASSWORD`: database-owner password, used only by Postgres and explicit
  operator tasks.
- `CAPYKIT_DB_PASSWORD`: password for the application's restricted database login.
- `CAPYKIT_AUTH_DB_PASSWORD`: password for the auth schema owner.
- `CAPYKIT_AUTH_JWT_SECRET`: at least 32 random bytes for GoTrue signing.
- Optional `CAPYKIT_HTTP_PORT` and `CAPYKIT_MAIL_PORT`: default 19121 and 19122.
- Optional `CAPYKIT_IMAGE`: an immutable application image tag for deployment and
  rollback; the default is suitable for local builds.

Generate separate 32-byte random hexadecimal values for all four secrets.
Hexadecimal passwords are safe in the Compose database connection URLs. Keep
this file mode `0600` and its directory private. Do not print expanded Compose
configuration: it contains interpolated credentials.

```sh
docker compose --env-file /path/to/protected-config -p capykit-staging config -q
docker compose --env-file /path/to/protected-config -p capykit-staging build app
docker compose --env-file /path/to/protected-config -p capykit-staging up -d --wait
```

The application and inbox bind only to loopback. PostgreSQL, auth, and SMTP have
no host ports. Add private HTTPS ingress for the application and inbox. On a
Tailscale host, use separate Serve ports pointing to the corresponding loopback
ports; preserve existing routes. Tailnet access is the test inbox's access
boundary. Everyone allowed into that inbox can read staging login codes.

The API receives only `DATABASE_URL`, `CAPYKIT_AUTH_URL`, its public origin, and
its port. The application does not receive database-owner credentials, an auth
admin token, or the auth signing secret. The server-only auth URL can use HTTP
inside the private container network. Public URLs still require HTTPS except on
loopback.

Mailpit captures email inside the stack; it does not send messages to external
recipients. Request a code in Capykit, read it in the private test inbox, and
enter it in the application. Replace the GoTrue SMTP settings with an approved
SMTP relay for real email delivery. Remove inbox ingress before opening signup
or using this deployment with real customers.

## Database and first owner

The fresh-volume initializer creates separate database roles, then applies
migrations 001 through 003 in one transaction. RLS protects all application tables.
`capykit_api` inherits `capykit_runtime`: the four identity tables remain read-only,
while capability operations require transaction-scoped workspace/owner context.
The runtime cannot create tables or act as a database owner.
`capykit_auth` owns only its auth schema. The schema owner performs application
migrations and owner bootstrap separately.

Initialization runs only on an empty Postgres volume. For upgrades, take a backup
and apply new migrations explicitly with operator credentials. Never delete a
volume to force initialization. Apply 001 through 003 together when creating an
application schema manually, so tables are never committed without access rules.

`scripts/provision-hosted-owner.mjs` is an operator-only command. It creates a
confirmed GoTrue user without sending an email, or finds the existing verified
user, then invokes the transactional workspace bootstrap. Supply these variables
only to that one-shot process:

- `DATABASE_URL`: schema-owner connection.
- `CAPYKIT_AUTH_URL`: private GoTrue origin.
- `CAPYKIT_AUTH_JWT_SECRET`: the matching auth signing secret.
- `CAPYKIT_BOOTSTRAP_OWNER_EMAIL`: the intended initial owner.
- `CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG` and `CAPYKIT_BOOTSTRAP_WORKSPACE_NAME`.

After injecting those operator variables into the calling environment, run:

```sh
docker compose --env-file /path/to/protected-config -p capykit-staging \
  run --rm --no-deps \
  -e DATABASE_URL -e CAPYKIT_AUTH_JWT_SECRET \
  -e CAPYKIT_BOOTSTRAP_OWNER_EMAIL -e CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG \
  -e CAPYKIT_BOOTSTRAP_WORKSPACE_NAME \
  app node scripts/provision-hosted-owner.mjs
```

The admin token is short-lived and kept in memory. Provisioning is replayable:
workspace identity and owner membership retain their IDs. It refuses banned or
unverified existing auth users and inactive or mismatched application identities.
The lower-level `scripts/bootstrap-hosted-owner.mjs` accepts an already verified
`CAPYKIT_BOOTSTRAP_AUTH_USER_ID` instead of administering GoTrue users.

Auth-user creation and application bootstrap are separate transactions. If the
second step fails, the auth user can remain, but receives no workspace access.
Correct the bootstrap configuration and rerun; do not reactivate revoked records
as a side effect of recovery.

## Browser sessions and authorization

Public signup is disabled. The console requests a six-digit code through the
same-origin API, which uses GoTrue's established OTP flow. The auth service loads
the static template from `/auth/email-template`; this route contains the template
placeholder, never a real code. Unknown and invited emails get the same public
request response. Codes expire and have provider rate limits.

Successful verification creates Secure, HttpOnly, SameSite=Strict session
cookies. Access and refresh tokens are never returned to browser JavaScript or
stored in browser storage. Unsafe cookie-authenticated requests require the
matching origin and double-submit CSRF token. Callback origins are explicit.

Every protected request verifies the provider session and reads current workspace
membership. Inactive workspaces, principals, or memberships are denied on the
next request. Owner/creator attribution does not imply an execution grant.
Logout clears cookies and revokes the current GoTrue session; subsequent requests
still validate with GoTrue rather than trusting a JWT offline. Sessions expire
after one hour; this foundation does not implement silent refresh.

Workspace-owned relationships use compound database constraints to reject
cross-workspace substitutions. Browser roles have no direct table access. No
PostgREST/Data API or public storage service is deployed. Artifact storage is a
separate ENG-122 requirement and must have its own private access controls.

## Operations and verification

Compose sets restart policies, CPU/memory limits, health checks, and bounded log
rotation. Docker restart policies handle daemon/host restarts. PostgreSQL and
Mailpit persist in named volumes tied to the stable Compose project name.

```sh
docker compose --env-file /path/to/protected-config -p capykit-staging ps
docker compose --env-file /path/to/protected-config -p capykit-staging \
  logs --tail 50
docker compose --env-file /path/to/protected-config -p capykit-staging restart app
curl --fail http://127.0.0.1:19121/health/ready
```

`/health/live` reports process liveness. `/health/ready` checks required
application configuration and database schema readability; auth has its own health
check. These probes do not prove email delivery. API request logging is disabled,
and provider errors are converted to bounded public error codes with request IDs.
Treat infrastructure logs and the test inbox as private.

Back up with `pg_dump -Fc` from the Postgres container, writing the archive to a
protected operator directory. Save database-role definitions separately with
`pg_dumpall --globals-only`; they contain password hashes and require the same
protection. Verify a restore into a separate disposable database before relying
on the backup. Keep an off-host copy for disaster recovery; local volumes and
local backup files share the VPS failure boundary.

Record the deployed source commit and immutable image tag before updating. To
roll back the app, restore the previous `CAPYKIT_IMAGE` and use `up -d --no-build
app`. Database rollback requires a compatible migration plan or verified backup;
rolling back an image does not undo schema changes. Preserve volumes on stop.

Run `npm run factory:verify` for lint, types, tests, package smoke, schema/security
checks, and production dependency audit. Set `CAPYKIT_TEST_POSTGRES_URL` to a
**disposable** database with role/schema creation rights to include real database
checks. Tests create and remove their own schemas and roles. Without this
variable the PostgreSQL tests are explicitly skipped.

For deployment acceptance, exercise real code delivery into Mailpit, browser
login, `/v1/me`, reload/restart persistence, logout-token replay rejection,
inactive-membership rejection, invalid-code handling, and CSRF rejection. Check
that credentials and codes are absent from browser assets and infrastructure
logs. This proves the identity foundation, not the later connection/run product.
