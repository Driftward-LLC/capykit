# Hosted workspace foundation

This repository now keeps the hosted application boundary separate from the existing CLI/MCP package.

## Processes

- API/web: `npm run start:hosted-api` starts the Fastify service and serves the same-origin console shell.
- Worker: `npm run start:hosted-worker` starts the Railway worker healthcheck skeleton. It does not claim GitHub App access or isolated execution; those stay in ENG-123 and ENG-125.
- Web assets: `npm run build` compiles the Node entries and the Vite console bundle.

## Managed prerequisites

Set these in Railway or the equivalent managed service variable store, never in committed files:

- `DATABASE_URL` for a direct or session-pooled Supabase Postgres connection.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for server-side verification only.
- `CAPYKIT_PUBLIC_BASE_URL` for the deployed same-origin API/web URL.
- `CAPYKIT_ALLOWED_CALLBACK_ORIGINS` as a comma-separated exact origin allow-list.
- `CAPYKIT_BOOTSTRAP_WORKSPACE_SLUG`, `CAPYKIT_BOOTSTRAP_WORKSPACE_NAME`, `CAPYKIT_BOOTSTRAP_SUPABASE_USER_ID`, and `CAPYKIT_BOOTSTRAP_OWNER_EMAIL` for the one-time owner bootstrap.

Supabase signup remains disabled. Pre-create or invite users in Supabase, configure custom SMTP and the approved sender, and restrict callback URLs to the exact deployed origins before inviting the pilot owner. Disable browser Data API access to application tables and provision private Storage without public-read policies before artifact work begins.

## Database and bootstrap

1. Apply `scripts/migrations/001_hosted_workspace_identity.sql` with the schema owner role.
2. Run `node scripts/bootstrap-hosted-owner.mjs` with the bootstrap variables above and runtime credentials that can insert rows but are not used by the web process.
3. Rerun the bootstrap command to verify it updates the same workspace/user binding instead of creating a duplicate owner.
4. Start API and worker with the runtime database role. Runtime roles must not own schemas or have DDL privileges.

Workspace-owned downstream tables should use compound `(workspace_id, id)` keys and reference parent resources with compound foreign keys so cross-workspace substitution fails in Postgres before application code runs.

## Auth and request safety

The hosted API verifies Supabase bearer tokens server-side, resolves the active principal and workspace membership from Postgres, and ignores client-supplied workspace, role, principal, and membership assertions. Cookie-authenticated mutations require the same-origin CSRF token. Missing or invalid auth returns 401, inactive membership returns 401, cross-workspace IDs should return 404, and known in-workspace permission failures should return 403 with stable error codes and request IDs.

Health responses report whether configuration or the database is unavailable without echoing connection strings, keys, cookies, OTP codes, authorization headers, request bodies, or provider token responses.
