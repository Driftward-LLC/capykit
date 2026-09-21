# Hosted workspace foundation

ENG-121 adds the hosted application boundary without replacing the existing CLI or read-only MCP package.

## Processes

- API/web: `npm run start:api` serves Fastify API routes and the same-origin console.
- Worker: `npm run start:worker` starts a separate Railway worker skeleton. It deliberately does not claim GitHub App access or isolated E2B execution; those are downstream ENG-123/ENG-125 gates.

## Managed service prerequisites

Set these as managed service variables, not files committed to this repository: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CAPYKIT_COOKIE_SECRET`, `CAPYKIT_PUBLIC_ORIGIN`, and `CAPYKIT_ALLOWED_CALLBACK_ORIGINS`. Configure Supabase Auth with signup disabled, custom SMTP, approved sender, and exact callback origins.

Runtime logs redact cookies, authorization headers, request bodies, OTP/OAuth codes by omission, and provider token responses. Health readiness reports only `configured` or `missing`, never values.

## Migrations and owner bootstrap

Apply migrations with a schema-owner credential, then run the idempotent owner bootstrap with the pre-created Supabase user email:

```bash
psql "$DATABASE_URL" -f src/app/migrations/001_workspace_identity.sql
node scripts/bootstrap-owner.mjs owner@example.com "Pilot workspace"
```

Rollback for the initial foundation is to restore from backup before dependent resource tables exist. If bootstrap is rerun for the same email, `bootstrap_owner` returns the existing workspace instead of duplicating it.

## Authorization contract

Authenticated requests resolve the verified principal server-side from the session cookie, then require an active membership in that principal's workspace. Client-supplied workspace, role, membership, or principal assertions are ignored for authorization. Missing or invalid authentication returns 401; cross-workspace IDs return 404; known in-workspace operations without permission return 403. Responses expose stable error codes and request IDs only.

Downstream resource tables must use compound `(workspace_id, resource_id)` references so cross-workspace foreign-key substitution fails in Postgres, not only in application code. Runtime database credentials must not own schema migrations or DDL permissions. Supabase browser Data API access to application tables stays disabled, and private Storage buckets must have no public-read policies.
