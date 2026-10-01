create table if not exists capability_grants (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  recipient_principal_id uuid not null,
  capability_id uuid not null,
  version text not null,
  action text not null check (action in ('retrieve', 'invoke')),
  operation text,
  connection_id uuid,
  repository_ids text[] not null default '{}',
  expires_at timestamptz not null,
  created_by_principal_id uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, recipient_principal_id) references principals(workspace_id, id),
  foreign key (workspace_id, created_by_principal_id) references principals(workspace_id, id),
  foreign key (workspace_id, capability_id, version) references capability_versions(workspace_id, capability_id, version),
  foreign key (workspace_id, connection_id) references provider_connections(workspace_id, id),
  check (expires_at > created_at),
  check ((action = 'retrieve' and operation is null and connection_id is null and cardinality(repository_ids) = 0)
    or (action = 'invoke' and operation = 'github.issues.list.v1' and connection_id is not null
      and cardinality(repository_ids) between 1 and 500))
);
create index if not exists capability_grants_recipient on capability_grants(workspace_id, recipient_principal_id, capability_id, version);
create table if not exists grant_audit (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  grant_id uuid not null,
  actor_principal_id uuid not null,
  action text not null check (action in ('created', 'revoked')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, grant_id) references capability_grants(workspace_id, id),
  foreign key (workspace_id, actor_principal_id) references principals(workspace_id, id)
);
create or replace function grant_scope_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Retain grant scope' using errcode = '23514'; end if;
  if (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
    or old.revoked_at is not null or new.revoked_at is null then
    raise exception 'Immutable grant scope' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists grant_scope_immutable on capability_grants;
create trigger grant_scope_immutable before update or delete on capability_grants for each row execute function grant_scope_immutable();
drop trigger if exists grant_audit_immutable on grant_audit;
create trigger grant_audit_immutable before update or delete on grant_audit for each row execute function capability_reject_mutation();

do $$
declare target_schema text := current_schema(); table_name text; browser_role text;
begin
  foreach table_name in array array['capability_grants', 'grant_audit'] loop
    execute format('alter table %I.%I enable row level security', target_schema, table_name);
    execute format('revoke all on table %I.%I from public, capykit_runtime', target_schema, table_name);
    foreach browser_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = browser_role) then
        execute format('revoke all on table %I.%I from %I', target_schema, table_name, browser_role);
      end if;
    end loop;
    execute format('grant select, insert on table %I.%I to capykit_runtime', target_schema, table_name);
    execute format('drop policy if exists grant_owner on %I.%I', target_schema, table_name);
    execute format('create policy grant_owner on %I.%I to capykit_runtime using (capability_active_owner(workspace_id)) with check (capability_active_owner(workspace_id))', target_schema, table_name);
  end loop;
  execute format('grant update (revoked_at) on %I.capability_grants to capykit_runtime', target_schema);
  execute format('drop policy if exists grant_recipient on %I.capability_grants', target_schema);
  execute format('create policy grant_recipient on %I.capability_grants for select to capykit_runtime using (capability_active_member(workspace_id) and recipient_principal_id = nullif(current_setting(''capykit.principal_id'', true), '''')::uuid)', target_schema);
  -- Repository metadata is readable only where a current recipient grant names it.
  execute format('drop policy if exists grant_repository_read on %I.connection_repositories', target_schema);
  execute format('create policy grant_repository_read on %I.connection_repositories for select to capykit_runtime using (capability_active_member(workspace_id) and exists (select 1 from capability_grants g where g.workspace_id = connection_repositories.workspace_id and g.connection_id = connection_repositories.connection_id and g.recipient_principal_id = nullif(current_setting(''capykit.principal_id'', true), '''')::uuid and g.revoked_at is null and g.expires_at > now() and connection_repositories.repository_id = any(g.repository_ids)))', target_schema);
end $$;

-- No elevation or cached authorization: the current member, grant and connection
-- state are evaluated on each read. A grant never widens when repositories change.
create or replace function capability_granted_version(target_workspace uuid, target_capability uuid, target_version text) returns boolean
language sql stable as $$
  select capability_active_member(target_workspace) and exists (
    select 1 from capability_grants g
    where g.workspace_id = target_workspace and g.capability_id = target_capability and g.version = target_version
      and g.recipient_principal_id = nullif(current_setting('capykit.principal_id', true), '')::uuid
      and g.revoked_at is null and g.expires_at > now()
      and (g.action = 'retrieve' or (g.action = 'invoke' and exists (
        select 1 from provider_connections c where c.workspace_id = g.workspace_id and c.id = g.connection_id
          and c.status = 'active' and c.installation_id is not null
      ) and not exists (
        select 1 from unnest(g.repository_ids) requested(id) where not exists (
          select 1 from connection_repositories r where r.workspace_id = g.workspace_id
            and r.connection_id = g.connection_id and r.repository_id = requested.id
        )
      )))
  )
$$;
do $$
declare target_schema text := current_schema(); table_name text;
begin
  execute format('drop policy if exists grant_version_read on %I.capability_versions', target_schema);
  execute format('create policy grant_version_read on %I.capability_versions for select to capykit_runtime using (capability_granted_version(workspace_id, capability_id, version))', target_schema);
  foreach table_name in array array['capability_artifacts', 'capability_artifact_files'] loop
    execute format('drop policy if exists grant_artifact_read on %I.%I', target_schema, table_name);
    execute format('create policy grant_artifact_read on %I.%I for select to capykit_runtime using (exists (select 1 from capability_versions v where v.workspace_id = %I.workspace_id and v.capability_id = %I.capability_id and v.artifact_id = %I.%s and capability_granted_version(v.workspace_id, v.capability_id, v.version)))', target_schema, table_name, table_name, table_name, table_name, case when table_name = 'capability_artifacts' then 'id' else 'artifact_id' end);
  end loop;
end $$;
