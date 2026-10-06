-- One dedicated Google Drive account per workspace for owner connection tests.
-- Persistent refresh credentials are AEAD encrypted with a separate operator key.
create table if not exists google_connections (
 workspace_id uuid primary key references workspaces(id),
 status text not null default 'pending' check(status in ('pending','active','revoked','reconnect_required')),
 generation integer not null check(generation>0),
 principal_id uuid not null,
 email text, subject text, session_hash text, state_hash text, verifier jsonb, refresh_token jsonb,
 expires_at timestamptz, updated_at timestamptz not null default now(),
 foreign key(workspace_id,principal_id) references principals(workspace_id,id),
 check(status<>'active' or (refresh_token is not null and email is not null and subject is not null)),
 check(status='pending' or (state_hash is null and verifier is null and session_hash is null and expires_at is null))
);
create table if not exists app_connection_audit (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id),
 principal_id uuid not null, app text not null check(app in ('github','google-drive')),
 action text not null check(action in ('setup_started','connected','disconnected','cleanup_failed','test_started','test_succeeded','test_failed')),
 created_at timestamptz not null default now(),
 foreign key(workspace_id,principal_id) references principals(workspace_id,id)
);
do $$
declare table_name text; browser_role text;
begin
 foreach table_name in array array['google_connections','app_connection_audit'] loop
  execute format('alter table %I enable row level security',table_name);
  execute format('revoke all on %I from public,capykit_runtime',table_name);
  foreach browser_role in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=browser_role) then execute format('revoke all on %I from %I',table_name,browser_role); end if;
  end loop;
  execute format('grant select,insert,update,delete on %I to capykit_runtime',table_name);
  execute format('drop policy if exists app_owner on %I',table_name);
  execute format('create policy app_owner on %I to capykit_runtime using(capability_active_owner(workspace_id)) with check(capability_active_owner(workspace_id))',table_name);
 end loop;
 revoke update,delete on app_connection_audit from capykit_runtime;
end $$;
