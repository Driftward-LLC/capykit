-- Personal account authority never follows workspace-owner authority.
create table if not exists personal_app_connections (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), owner_principal_id uuid not null,
 app_id text not null, connector_version text not null, display_name text not null,
 status text not null default 'pending' check(status in ('pending','active','revoked','reconnect_required')),
 generation integer not null default 1 check(generation>0), upstream_id text, external_id text not null unique,
 setup jsonb, state_hash text, session_hash text, expires_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(workspace_id,id), unique(workspace_id,id,owner_principal_id),
 foreign key(workspace_id,owner_principal_id) references principals(workspace_id,id),
 check(status<>'active' or upstream_id is not null),
 check(status='pending' or (setup is null and state_hash is null and session_hash is null and expires_at is null))
);
create table if not exists personal_action_grants (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), connection_id uuid not null,
 grantor_principal_id uuid not null, recipient_principal_id uuid not null, action_name text not null,
 generation integer not null, connector_version text not null, expires_at timestamptz not null,
 revoked_at timestamptz, created_at timestamptz not null default now(), primary key(workspace_id,id),
 foreign key(workspace_id,connection_id,grantor_principal_id) references personal_app_connections(workspace_id,id,owner_principal_id),
 foreign key(workspace_id,recipient_principal_id) references principals(workspace_id,id),
 check(expires_at>created_at)
);
create index if not exists personal_action_recipient on personal_action_grants(workspace_id,recipient_principal_id,connection_id);
create table if not exists personal_connection_audit (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), actor_principal_id uuid not null,
 connection_id uuid not null, event text not null, action_name text, grant_id uuid,
 created_at timestamptz not null default now(), primary key(workspace_id,id),
 foreign key(workspace_id,actor_principal_id) references principals(workspace_id,id)
);
create or replace function personal_connection_granted(target_workspace uuid,target_connection uuid) returns boolean
language sql stable security definer as $$
 select capability_active_member(target_workspace) and exists(
  select 1 from personal_action_grants g join personal_app_connections c on c.workspace_id=g.workspace_id and c.id=g.connection_id
  join workspace_memberships m on m.workspace_id=c.workspace_id and m.principal_id=c.owner_principal_id
  join principals p on p.workspace_id=m.workspace_id and p.id=m.principal_id
  where g.workspace_id=target_workspace and g.connection_id=target_connection
  and g.recipient_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid
  and g.revoked_at is null and g.expires_at>now() and g.generation=c.generation and g.connector_version=c.connector_version
  and c.status='active' and m.active and p.active
 )
$$;
do $$
declare table_name text; browser_role text; target_schema text:=current_schema();
begin
 foreach table_name in array array['personal_app_connections','personal_action_grants','personal_connection_audit'] loop
  execute format('alter table %I enable row level security',table_name);
  execute format('revoke all on %I from public,capykit_runtime',table_name);
  foreach browser_role in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=browser_role) then execute format('revoke all on %I from %I',table_name,browser_role);end if;
  end loop;
  execute format('grant select,insert on %I to capykit_runtime',table_name);
 end loop;
 execute format('alter function personal_connection_granted(uuid,uuid) set search_path=%I,pg_temp',target_schema);
 revoke all on function personal_connection_granted(uuid,uuid) from public;
 grant execute on function personal_connection_granted(uuid,uuid) to capykit_runtime;
end $$;
grant update(status,generation,upstream_id,setup,state_hash,session_hash,expires_at,updated_at) on personal_app_connections to capykit_runtime;
grant update(revoked_at) on personal_action_grants to capykit_runtime;
drop policy if exists personal_connection_read on personal_app_connections;
create policy personal_connection_read on personal_app_connections for select to capykit_runtime using(capability_active_member(workspace_id) and (owner_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid or personal_connection_granted(workspace_id,id)));
drop policy if exists personal_connection_insert on personal_app_connections;
create policy personal_connection_insert on personal_app_connections for insert to capykit_runtime with check(capability_active_member(workspace_id) and owner_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid and exists(select 1 from principals p where p.workspace_id=personal_app_connections.workspace_id and p.id=personal_app_connections.owner_principal_id and p.kind='human'));
drop policy if exists personal_connection_update on personal_app_connections;
create policy personal_connection_update on personal_app_connections for update to capykit_runtime using(capability_active_member(workspace_id) and owner_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid) with check(capability_active_member(workspace_id) and owner_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid);
drop policy if exists personal_grant_read on personal_action_grants;
create policy personal_grant_read on personal_action_grants for select to capykit_runtime using(capability_active_member(workspace_id) and (grantor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid or recipient_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid));
drop policy if exists personal_grant_insert on personal_action_grants;
create policy personal_grant_insert on personal_action_grants for insert to capykit_runtime with check(capability_active_member(workspace_id) and grantor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid and exists(select 1 from personal_app_connections c where c.workspace_id=personal_action_grants.workspace_id and c.id=personal_action_grants.connection_id and c.owner_principal_id=personal_action_grants.grantor_principal_id));
drop policy if exists personal_grant_update on personal_action_grants;
create policy personal_grant_update on personal_action_grants for update to capykit_runtime using(capability_active_member(workspace_id) and grantor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid) with check(capability_active_member(workspace_id) and grantor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid);
drop policy if exists personal_audit_actor on personal_connection_audit;
create policy personal_audit_actor on personal_connection_audit to capykit_runtime using(capability_active_member(workspace_id) and actor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid) with check(capability_active_member(workspace_id) and actor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid);
drop trigger if exists personal_grant_immutable on personal_action_grants;
create trigger personal_grant_immutable before update or delete on personal_action_grants for each row execute function grant_scope_immutable();
drop trigger if exists personal_audit_immutable on personal_connection_audit;
create trigger personal_audit_immutable before update or delete on personal_connection_audit for each row execute function capability_reject_mutation();
