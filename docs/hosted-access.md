# Workspace user access

Workspace owners use **Access** to grant an already invited human user an exact
published capability version. Invite provisioning remains operator-managed;
there is no public signup or automatic membership creation.

1. Publish a skill or function in **Capabilities**.
2. Open **Access**, choose the user and published version, and set an expiry.
   The default is 30 days; the maximum is one year. Times use your browser's
   local timezone.
3. For a function, choose an active GitHub connection and explicitly check the
   repositories it may use. No repositories are selected automatically.
4. Review the scope, check the approval box, and click **Grant access**.
5. Use **Revoke access** in Existing grants to stop future authorized requests.
   Copies of skills already downloaded cannot be recalled.

Members see only their granted published versions in Capabilities. They can
download a complete granted skill, including its supporting files, but cannot
edit, publish, delete, or download function source. A skill grant does not grant
GitHub access. A function grant delegates the connection's read permission even
when the recipient has no independent GitHub repository access.

New versions or repositories require new grants. Removing a granted repository,
suspending or reconnecting the connection, deactivating membership, deleting
the capability, expiry, or revocation blocks subsequent access. Owners manage
the catalog but still need an explicit grant to invoke functions.

This delivery supports human user grants. Agent keys, authenticated remote MCP,
and function execution remain separate ENG-124/ENG-125 work. Granting a function
records its scope; it does not execute it.

## API and authorization

All routes use the existing authenticated workspace context and cookie CSRF
checks. Workspace and actor IDs cannot be supplied in grant creation requests.

| Route | Behavior |
| --- | --- |
| `GET /v1/access/options` | Owner-only choices and repository scope |
| `GET /v1/grants?cursor=…` | Workspace/own grants, 50 per page |
| `POST /v1/grants` | Owner creates an exact-version grant |
| `DELETE /v1/grants/:id` | Owner revokes idempotently |

Options are bounded to 200 users, versions and connections; the console reports
truncation. Repository choices use the existing connection scope (maximum 500).
Creation and revocation write safe audit records transactionally. PostgreSQL
RLS restricts runtime access; browser database roles receive no table access.

`GrantStore.authorizeFunction(context, access, boundGrantId?)` is the authorization
seam for the future executor. It requires a single current grant covering the
entire requested repository set, exact version, operation and connection.
Overlapping grants are never unioned. Selection orders by creation time then ID;
a bound run cannot switch grants after revocation. The executor must call this
at its request, idempotency, dispatch, provider and response boundaries. This
method does not dispatch work or replace those future checks.

## Database upgrade

Fresh deployments apply `005_hosted_grants.sql` after migrations 001–004 through
`deploy/init-postgres.sh`. Existing deployments must back up the database and
apply 005 as the schema owner in a transaction with `ON_ERROR_STOP` before
starting this app version. Runtime readiness checks require the grant tables.
The migration is repeatable and preserves existing capabilities/connections.

For an app rollback, restore the previous app image and configuration while
retaining the additive grant tables and audit history. Do not drop grant data
or restore an older database over live writes merely to roll back the app.

## Verification

The PostgreSQL suite uses a disposable database and a separate runtime role to
exercise tenant boundaries, exact artifacts, current authority, immutable
scope, one-whole-grant selection, expiry and immediate revocation.

```sh
CAPYKIT_TEST_POSTGRES_URL=postgresql://… npm run check
```

Browser checks use an external Playwright installation, without adding a
product dependency. Build first, then run:

```sh
CAPYKIT_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/test-access-flow.mjs
```
