# Hosted workspace and durable application state

This is the implementation baseline for Linear ENG-121. It keeps public catalog
metadata separate from hosted application state: catalog records stay in the
existing registry paths, while workspace membership, credentials, and runtime
configuration live in Supabase-managed storage.

## Service choices

- Web/API: one Railway-hosted TypeScript service. Fastify serves the API and the
  Vite console from the same origin so session cookies and CSRF checks share one
  trust boundary.
- Worker: one separate Railway worker process using the same codebase and
  Supabase project. The worker accepts jobs only after resolving the stored
  workspace/principal membership.
- Identity: Supabase email OTP for humans. Agent principals are first-class rows
  with distinct membership roles and cannot borrow a human principal ID.
- Durable state: Supabase Postgres for workspaces, principals, memberships, and
  application records. Supabase private Storage is reserved for private artifacts.
- Downstream integrations: GitHub App installation access and offline E2B
  execution are deferred to ENG-123 and ENG-125 integration tests.

## Bootstrap order

1. Create the Supabase project and Railway project outside the repository.
2. Apply the migration below to the Supabase Postgres database.
3. Seed exactly one invite-only pilot workspace, one owner human principal, and
   one agent principal for the first rollout.
4. Configure Railway variables for the Supabase URL and service credentials in
   Railway only. Do not commit secrets, env files, or generated tokens.
5. Deploy the API and worker from the same commit. The API refuses protected
   requests unless the Supabase-authenticated subject maps to an active principal
   and active workspace membership.

## Initial migration

```sql
create type hosted_principal_kind as enum ('human', 'agent');
create type hosted_membership_role as enum ('owner', 'admin', 'member', 'agent');
create type hosted_record_status as enum ('active', 'disabled');

create table hosted_workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status hosted_record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hosted_principals (
  id uuid primary key default gen_random_uuid(),
  kind hosted_principal_kind not null,
  external_subject text not null unique,
  display_name text not null,
  status hosted_record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table hosted_memberships (
  workspace_id uuid not null references hosted_workspaces(id) on delete cascade,
  principal_id uuid not null references hosted_principals(id) on delete cascade,
  role hosted_membership_role not null,
  status hosted_record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, principal_id)
);

create index hosted_memberships_principal_idx
  on hosted_memberships (principal_id, status);
```

Every protected application table must carry `workspace_id uuid not null
references hosted_workspaces(id)` and query through the authenticated membership
context. Request-supplied workspace IDs are selectors only; they never grant
access by themselves.

## Same-origin session and CSRF contract

- The API exchanges Supabase OTP identity for an HTTP-only, `SameSite=Lax`,
  secure session cookie.
- Unsafe methods require a CSRF token bound to that session. Missing or mismatched
  tokens fail before application handlers run.
- Handlers resolve the principal from the server-side session subject, load active
  memberships from Postgres, and then choose the active workspace from those rows.
- The console may request a workspace switch, but the backend accepts it only
  when the membership row is active.

## Local verification scope

`src/core/hosted-state.ts` is the dependency-free contract used by tests and
future Fastify handlers. It models the server-side membership resolution that the
hosted API and worker must share, including human/agent distinction and
second-workspace isolation.
