create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$ begin
  create type principal_kind as enum ('human', 'agent');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type membership_role as enum ('owner', 'member');
exception when duplicate_object then null;
end $$;

create table if not exists principals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  kind principal_kind not null,
  display_name text not null,
  active boolean not null default true,
  created_by_principal_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

do $$ begin
  alter table principals
    add constraint principals_creator_same_workspace
    foreign key (workspace_id, created_by_principal_id)
    references principals(workspace_id, id);
exception when duplicate_object then null;
end $$;

create table if not exists identity_bindings (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals(id),
  provider text not null,
  provider_subject text not null,
  email citext not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject),
  unique (principal_id, provider)
);

create table if not exists workspace_memberships (
  workspace_id uuid not null references workspaces(id),
  principal_id uuid not null,
  role membership_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (workspace_id, principal_id),
  foreign key (workspace_id, principal_id) references principals(workspace_id, id)
);

create table if not exists capability_publications (
  workspace_id uuid not null references workspaces(id),
  id uuid not null default gen_random_uuid(),
  created_by_principal_id uuid not null,
  name text not null,
  schema jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, created_by_principal_id) references principals(workspace_id, id)
);
