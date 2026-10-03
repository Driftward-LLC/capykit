-- Direct, trusted connector actions have their own grants; these never authorize uploaded code.
create table if not exists agent_credentials (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), principal_id uuid not null,
 key_hash text not null unique check(key_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null, created_at timestamptz not null default now(), revoked_at timestamptz,
 primary key(workspace_id,id), foreign key(workspace_id,principal_id) references principals(workspace_id,id),
 check(expires_at > created_at)
);
create table if not exists connector_action_grants (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), recipient_principal_id uuid not null,
 action_id text not null check(action_id in ('github.get-issue.v1','drive.get-file.v1','drive.find-files.v1','drive.list-folder.v1')),
 connection_id uuid not null, generation integer not null, connector_version text not null,
 repository_ids text[] not null default '{}', expires_at timestamptz not null,
 created_at timestamptz not null default now(), revoked_at timestamptz,
 primary key(workspace_id,id), foreign key(workspace_id,recipient_principal_id) references principals(workspace_id,id),
 check(expires_at > created_at),
 check((action_id='github.get-issue.v1' and cardinality(repository_ids) between 1 and 500 and connector_version='0.9.0')
   or (action_id like 'drive.%' and cardinality(repository_ids)=0 and connector_version='0.11.0' and connection_id=workspace_id))
);
create index if not exists connector_action_grants_recipient on connector_action_grants(workspace_id,recipient_principal_id,action_id,connection_id);
create table if not exists connector_action_audit (
 workspace_id uuid not null, id uuid not null default gen_random_uuid(), actor_principal_id uuid not null,
 event text not null check(event in ('key_issued','key_revoked','grant_created','grant_revoked','run_started','run_succeeded','run_failed')),
 action_id text, grant_id uuid, created_at timestamptz not null default now(),
 primary key(workspace_id,id), foreign key(workspace_id,actor_principal_id) references principals(workspace_id,id)
);
do $$
declare target_schema text := current_schema(); table_name text; browser_role text;
begin
 foreach table_name in array array['agent_credentials','connector_action_grants','connector_action_audit'] loop
  execute format('alter table %I enable row level security',table_name);
  execute format('revoke all on %I from public,capykit_runtime',table_name);
  foreach browser_role in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=browser_role) then execute format('revoke all on %I from %I',table_name,browser_role); end if;
  end loop;
  execute format('grant select,insert on %I to capykit_runtime',table_name);
  execute format('drop policy if exists action_owner on %I',table_name);
  execute format('create policy action_owner on %I to capykit_runtime using(capability_active_owner(workspace_id)) with check(capability_active_owner(workspace_id))',table_name);
 end loop;
 grant update(revoked_at) on agent_credentials,connector_action_grants to capykit_runtime;
 drop policy if exists action_recipient on connector_action_grants;
 create policy action_recipient on connector_action_grants for select to capykit_runtime using(capability_active_member(workspace_id) and recipient_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid);
 drop policy if exists action_actor on connector_action_audit;
 create policy action_actor on connector_action_audit to capykit_runtime using(capability_active_member(workspace_id) and actor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid) with check(capability_active_member(workspace_id) and actor_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid);
end $$;
drop trigger if exists connector_action_grant_immutable on connector_action_grants;
create trigger connector_action_grant_immutable before update or delete on connector_action_grants for each row execute function grant_scope_immutable();
drop trigger if exists agent_credential_immutable on agent_credentials;
create trigger agent_credential_immutable before update or delete on agent_credentials for each row execute function grant_scope_immutable();
drop trigger if exists connector_action_audit_immutable on connector_action_audit;
create trigger connector_action_audit_immutable before update or delete on connector_action_audit for each row execute function capability_reject_mutation();

-- These functions return identity metadata only. Tokens/hashes never leave the backend.
create or replace function authenticate_connector_agent(digest text)
returns table(workspace_id uuid, principal_id uuid, credential_id uuid)
language sql stable security definer as $$
 select k.workspace_id,k.principal_id,k.id from agent_credentials k
 join principals p on p.workspace_id=k.workspace_id and p.id=k.principal_id
 join workspace_memberships m on m.workspace_id=p.workspace_id and m.principal_id=p.id
 join workspaces w on w.id=k.workspace_id
 where k.key_hash=digest and k.revoked_at is null and k.expires_at>now()
 and p.kind='agent' and p.active and m.active and m.role='member' and w.active
$$;
create or replace function connector_agent_credential_active(target_workspace uuid,target_principal uuid,target_key uuid)
returns boolean language sql stable security definer as $$
 select exists(select 1 from agent_credentials k where k.workspace_id=target_workspace and k.principal_id=target_principal
 and k.id=target_key and k.revoked_at is null and k.expires_at>now())
$$;
create or replace function create_connector_agent(agent_name text) returns uuid
language plpgsql security definer as $$
declare workspace uuid := nullif(current_setting('capykit.workspace_id',true),'')::uuid;
 actor uuid := nullif(current_setting('capykit.principal_id',true),'')::uuid;
 agent_id uuid := gen_random_uuid();
begin
 if not capability_active_owner(workspace) or length(agent_name) not between 1 and 80 then raise exception 'Forbidden' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace::text,146));
 if (select count(*) from principals where workspace_id=workspace and kind='agent')>=100 then raise exception 'Agent limit' using errcode='23514'; end if;
 insert into principals(id,workspace_id,kind,display_name,created_by_principal_id) values(agent_id,workspace,'agent',agent_name,actor);
 insert into workspace_memberships(workspace_id,principal_id,role) values(workspace,agent_id,'member');
 insert into identity_bindings(principal_id,provider,provider_subject,email,verified_at) values(agent_id,'capykit-agent',agent_id::text,agent_id::text||'@agents.invalid',now());
 return agent_id;
end $$;
-- Read credentials only when a live generation-bound Drive action grant exists.
create or replace function connector_drive_access(target_workspace uuid,target_generation integer) returns boolean
language sql stable as $$
 select capability_active_member(target_workspace) and exists(select 1 from connector_action_grants g
 where g.workspace_id=target_workspace and g.connection_id=target_workspace and g.generation=target_generation
 and g.connector_version='0.11.0' and g.action_id in ('drive.get-file.v1','drive.find-files.v1','drive.list-folder.v1')
 and g.recipient_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid and g.revoked_at is null and g.expires_at>now())
$$;
drop policy if exists action_drive_read on google_connections;
create policy action_drive_read on google_connections for select to capykit_runtime using(connector_drive_access(workspace_id,generation));
-- GitHub connection metadata is safe to read; the provider broker still checks the exact grant and repository.
drop policy if exists action_repository_read on connection_repositories;
create policy action_repository_read on connection_repositories for select to capykit_runtime using(capability_active_member(workspace_id) and exists(select 1 from connector_action_grants g where g.workspace_id=connection_repositories.workspace_id and g.connection_id=connection_repositories.connection_id and g.action_id='github.get-issue.v1' and g.recipient_principal_id=nullif(current_setting('capykit.principal_id',true),'')::uuid and g.revoked_at is null and g.expires_at>now() and connection_repositories.repository_id=any(g.repository_ids)));
do $$
declare target_schema text:=current_schema(); function_name text;
begin
 foreach function_name in array array['authenticate_connector_agent(text)','connector_agent_credential_active(uuid,uuid,uuid)','create_connector_agent(text)'] loop
  execute format('alter function %s set search_path=%I,pg_temp',function_name,target_schema);
  execute format('revoke all on function %s from public',function_name);
  execute format('grant execute on function %s to capykit_runtime',function_name);
 end loop;
end $$;
