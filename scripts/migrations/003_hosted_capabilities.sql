-- The foundation's unpublished placeholder has no runtime privileges or writers.
-- Refuse to discard unexpected data during upgrade.
do $$ begin
  if to_regclass('capability_publications') is not null then
    if exists (select 1 from capability_publications) then
      raise exception 'Migrate existing capability_publications before continuing';
    end if;
    drop table capability_publications;
  end if;
end $$;

create table if not exists capabilities (
  workspace_id uuid not null references workspaces(id),
  id uuid not null default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name text not null check (length(name) between 1 and 120),
  kind text not null check (kind in ('skill', 'function')),
  created_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (workspace_id, id),
  unique (workspace_id, slug),
  foreign key (workspace_id, created_by_principal_id) references principals(workspace_id, id)
);

create table if not exists capability_artifacts (
  workspace_id uuid not null,
  capability_id uuid not null,
  id uuid not null default gen_random_uuid(),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  byte_count integer not null check (byte_count between 0 and 33554432),
  file_count integer not null check (file_count between 1 and 512),
  metadata jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, capability_id, id),
  foreign key (workspace_id, capability_id) references capabilities(workspace_id, id)
);

create table if not exists capability_artifact_files (
  workspace_id uuid not null,
  capability_id uuid not null,
  artifact_id uuid not null,
  path text not null,
  content bytea not null check (octet_length(content) <= 8388608),
  primary key (workspace_id, capability_id, artifact_id, path),
  foreign key (workspace_id, capability_id, artifact_id)
    references capability_artifacts(workspace_id, capability_id, id) on delete cascade
);

create table if not exists capability_drafts (
  workspace_id uuid not null,
  capability_id uuid not null,
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  artifact_id uuid not null,
  updated_by_principal_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, capability_id),
  foreign key (workspace_id, capability_id, artifact_id)
    references capability_artifacts(workspace_id, capability_id, id),
  foreign key (workspace_id, updated_by_principal_id) references principals(workspace_id, id)
);

create table if not exists capability_versions (
  workspace_id uuid not null,
  capability_id uuid not null,
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  artifact_id uuid not null,
  published_by_principal_id uuid not null,
  published_at timestamptz not null default now(),
  primary key (workspace_id, capability_id, version),
  foreign key (workspace_id, capability_id, artifact_id)
    references capability_artifacts(workspace_id, capability_id, id),
  foreign key (workspace_id, published_by_principal_id) references principals(workspace_id, id)
);

create table if not exists capability_audit (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  capability_id uuid not null,
  actor_principal_id uuid not null,
  action text not null check (action in ('created', 'draft_saved', 'published', 'deleted')),
  version text,
  digest text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, capability_id) references capabilities(workspace_id, id),
  foreign key (workspace_id, actor_principal_id) references principals(workspace_id, id)
);

-- Transaction-local settings avoid pooled-connection identity leakage. These
-- functions do not elevate privileges; identity tables remain read-only.
create or replace function capability_active_member(target_workspace uuid) returns boolean
language sql stable as $$
  select target_workspace = nullif(current_setting('capykit.workspace_id', true), '')::uuid
    and exists (
      select 1 from workspace_memberships m
      join principals p on p.workspace_id = m.workspace_id and p.id = m.principal_id
      join workspaces w on w.id = m.workspace_id
      where m.workspace_id = target_workspace
        and m.principal_id = nullif(current_setting('capykit.principal_id', true), '')::uuid
        and m.active and p.active and w.active
    )
$$;
create or replace function capability_active_owner(target_workspace uuid) returns boolean
language sql stable as $$
  select capability_active_member(target_workspace) and exists (
    select 1 from workspace_memberships m
    join principals p on p.workspace_id = m.workspace_id and p.id = m.principal_id
    where m.workspace_id = target_workspace
      and m.principal_id = nullif(current_setting('capykit.principal_id', true), '')::uuid
      and m.role = 'owner' and p.kind = 'human'
  )
$$;

create or replace function capability_reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Immutable capability record' using errcode = '23514';
end $$;
create or replace function capability_protect_file_insert() returns trigger language plpgsql as $$
begin
  if exists (select 1 from capability_versions v where v.workspace_id = new.workspace_id
    and v.capability_id = new.capability_id and v.artifact_id = new.artifact_id) then
    raise exception 'Published capability bytes are immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create or replace function capability_protect_file() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from capability_versions v
    join capabilities c on c.workspace_id = v.workspace_id and c.id = v.capability_id
    where v.workspace_id = old.workspace_id and v.capability_id = old.capability_id
      and v.artifact_id = old.artifact_id and c.deleted_at is null
  ) then
    raise exception 'Published capability bytes are immutable' using errcode = '23514';
  end if;
  return old;
end $$;

drop trigger if exists capability_versions_immutable on capability_versions;
create trigger capability_versions_immutable before update or delete on capability_versions
  for each row execute function capability_reject_mutation();
drop trigger if exists capability_artifacts_immutable on capability_artifacts;
create trigger capability_artifacts_immutable before update on capability_artifacts
  for each row execute function capability_reject_mutation();
drop trigger if exists capability_files_immutable on capability_artifact_files;
create trigger capability_files_immutable before update on capability_artifact_files
  for each row execute function capability_reject_mutation();
drop trigger if exists capability_files_frozen on capability_artifact_files;
create trigger capability_files_frozen before insert on capability_artifact_files
  for each row execute function capability_protect_file_insert();
drop trigger if exists capability_files_retained on capability_artifact_files;
create trigger capability_files_retained before delete on capability_artifact_files
  for each row execute function capability_protect_file();
drop trigger if exists capability_audit_immutable on capability_audit;
create trigger capability_audit_immutable before update or delete on capability_audit
  for each row execute function capability_reject_mutation();

do $$
declare
  target_schema text := current_schema();
  table_name text;
  browser_role text;
begin
  foreach table_name in array array['capabilities', 'capability_artifacts',
    'capability_artifact_files', 'capability_drafts', 'capability_versions', 'capability_audit'] loop
    execute format('alter table %I.%I enable row level security', target_schema, table_name);
    execute format('revoke all on table %I.%I from public, capykit_runtime', target_schema, table_name);
    foreach browser_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = browser_role) then
        execute format('revoke all on table %I.%I from %I', target_schema, table_name, browser_role);
      end if;
    end loop;
    execute format('grant select, insert on table %I.%I to capykit_runtime', target_schema, table_name);
    execute format('drop policy if exists capability_owner on %I.%I', target_schema, table_name);
    execute format('create policy capability_owner on %I.%I to capykit_runtime using (capability_active_owner(workspace_id)) with check (capability_active_owner(workspace_id))', target_schema, table_name);
  end loop;
  execute format('grant update (deleted_at) on %I.capabilities to capykit_runtime', target_schema);
  execute format('grant update, delete on %I.capability_drafts to capykit_runtime', target_schema);
  execute format('grant delete on %I.capability_artifacts, %I.capability_artifact_files to capykit_runtime', target_schema, target_schema);
  -- Header existence is visible only within the current active workspace so
  -- the application can distinguish 403 from foreign/missing IDs (404).
  execute format('drop policy if exists capability_member_header on %I.capabilities', target_schema);
  execute format('create policy capability_member_header on %I.capabilities for select to capykit_runtime using (capability_active_member(workspace_id))', target_schema);
end $$;
