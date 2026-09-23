-- GitHub App connections contain only metadata. Personal setup credentials are
-- encrypted and short-lived; installation tokens are never persisted.
create table if not exists provider_connections (
  workspace_id uuid not null references workspaces(id),
  id uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended', 'reconnect_required', 'revoked')),
  generation integer not null default 0 check (generation >= 0),
  installation_id text unique check (installation_id ~ '^[1-9][0-9]{0,19}$'),
  account jsonb,
  permissions jsonb not null default '{"issues":"read","metadata":"read"}'::jsonb
    check (permissions = '{"issues":"read","metadata":"read"}'::jsonb),
  created_by_principal_id uuid not null,
  consent_by_principal_id uuid,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, created_by_principal_id) references principals(workspace_id, id),
  foreign key (workspace_id, consent_by_principal_id) references principals(workspace_id, id),
  check (status <> 'active' or (installation_id is not null and account is not null and consent_at is not null))
);
create table if not exists connection_repositories (
  workspace_id uuid not null,
  connection_id uuid not null,
  repository_id text not null check (repository_id ~ '^[1-9][0-9]{0,19}$'),
  full_name text not null check (length(full_name) between 1 and 240),
  url text not null check (length(url) between 1 and 500),
  primary key (workspace_id, connection_id, repository_id),
  foreign key (workspace_id, connection_id) references provider_connections(workspace_id, id)
);
create table if not exists connection_setups (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  connection_id uuid not null,
  principal_id uuid not null,
  generation integer not null,
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  state_hash text unique check (state_hash ~ '^[0-9a-f]{64}$'),
  phase text not null check (phase in ('authorizing', 'exchanging', 'confirming')),
  pkce_encrypted jsonb,
  tokens_encrypted jsonb,
  github_user_id text,
  candidates jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, connection_id),
  foreign key (workspace_id, connection_id) references provider_connections(workspace_id, id),
  foreign key (workspace_id, principal_id) references principals(workspace_id, id),
  check (expires_at <= created_at + interval '20 minutes'),
  check (phase = 'authorizing' or (state_hash is null and pkce_encrypted is null))
);
create index if not exists connection_setups_expiry on connection_setups(expires_at);
create table if not exists connection_audit (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  connection_id uuid not null,
  actor_principal_id uuid,
  request_id text not null check (length(request_id) between 1 and 128),
  action text not null check (action in ('setup_started', 'setup_verified', 'setup_failed', 'setup_cancelled', 'setup_expired', 'confirmed', 'disconnected', 'suspended', 'revoked', 'reconnect_required', 'repositories_removed', 'provider_cleanup_failed')),
  diagnostic text check (diagnostic in ('provider_failure', 'credential_invalid', 'state_invalid', 'expired', 'authority_changed', 'provider_cleanup_failed')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, connection_id) references provider_connections(workspace_id, id),
  foreign key (workspace_id, actor_principal_id) references principals(workspace_id, id)
);
create index if not exists connection_audit_retention on connection_audit(created_at);
create table if not exists connection_webhook_deliveries (
  id text primary key check (length(id) between 1 and 128),
  created_at timestamptz not null default now()
);
-- A monotonically increasing fence prevents a confirmation based on provider
-- proof fetched before a concurrent lifecycle event from restoring access.
create table if not exists connection_installation_events (
  installation_id text primary key check (installation_id ~ '^[1-9][0-9]{0,19}$'),
  revision integer not null default 1,
  action text not null,
  updated_at timestamptz not null default now()
);
create or replace function connection_binding_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Retain connection installation binding' using errcode = '23514'; end if;
  if new.workspace_id <> old.workspace_id or new.id <> old.id or
    (old.installation_id is not null and new.installation_id is distinct from old.installation_id) then
    raise exception 'Immutable connection installation binding' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists connection_binding_immutable on provider_connections;
create trigger connection_binding_immutable before update or delete on provider_connections
  for each row execute function connection_binding_guard();
create or replace function connection_system_access() returns boolean language sql stable as $$
  select current_setting('capykit.connection_system', true) = 'on'
$$;
create or replace function connection_audit_retention_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.created_at < now() - interval '30 days' and connection_system_access() then return old; end if;
  raise exception 'Immutable connection audit record' using errcode = '23514';
end $$;
drop trigger if exists connection_audit_immutable on connection_audit;
create trigger connection_audit_immutable before update or delete on connection_audit
  for each row execute function connection_audit_retention_guard();

do $$
declare target_schema text := current_schema(); table_name text; browser_role text;
begin
  foreach table_name in array array['provider_connections', 'connection_repositories', 'connection_setups', 'connection_audit', 'connection_webhook_deliveries', 'connection_installation_events'] loop
    execute format('alter table %I.%I enable row level security', target_schema, table_name);
    execute format('revoke all on table %I.%I from public, capykit_runtime', target_schema, table_name);
    foreach browser_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = browser_role) then
        execute format('revoke all on table %I.%I from %I', target_schema, table_name, browser_role);
      end if;
    end loop;
    execute format('grant select, insert, update, delete on table %I.%I to capykit_runtime', target_schema, table_name);
    execute format('drop policy if exists connection_system on %I.%I', target_schema, table_name);
    execute format('create policy connection_system on %I.%I to capykit_runtime using (connection_system_access()) with check (connection_system_access())', target_schema, table_name);
    if table_name in ('provider_connections', 'connection_repositories', 'connection_setups', 'connection_audit') then
      execute format('drop policy if exists connection_owner on %I.%I', target_schema, table_name);
      execute format('create policy connection_owner on %I.%I to capykit_runtime using (capability_active_owner(workspace_id)) with check (capability_active_owner(workspace_id))', target_schema, table_name);
    end if;
  end loop;
  execute format('drop policy if exists connection_member_header on %I.provider_connections', target_schema);
  execute format('create policy connection_member_header on %I.provider_connections for select to capykit_runtime using (capability_active_member(workspace_id))', target_schema);
  -- Audit updates are never needed, even by the trusted service cleanup path.
  execute format('revoke update on %I.connection_audit from capykit_runtime', target_schema);
end $$;
