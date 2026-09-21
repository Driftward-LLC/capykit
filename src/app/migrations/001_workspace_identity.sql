begin;
create table if not exists app_workspaces (workspace_id uuid primary key default gen_random_uuid(), name text not null, active boolean not null default true, created_at timestamptz not null default now());
create table if not exists app_principals (workspace_id uuid not null references app_workspaces(workspace_id), principal_id uuid not null default gen_random_uuid(), kind text not null check (kind in ('human', 'agent')), display_name text not null, active boolean not null default true, created_at timestamptz not null default now(), primary key (workspace_id, principal_id), unique (principal_id));
create table if not exists app_identity_bindings (workspace_id uuid not null, principal_id uuid not null, provider text not null, provider_subject text not null, verified_at timestamptz not null, primary key (provider, provider_subject), foreign key (workspace_id, principal_id) references app_principals(workspace_id, principal_id));
create table if not exists app_memberships (workspace_id uuid not null, principal_id uuid not null, role text not null check (role in ('owner', 'member')), active boolean not null default true, created_at timestamptz not null default now(), primary key (workspace_id, principal_id), foreign key (workspace_id, principal_id) references app_principals(workspace_id, principal_id));
create or replace function bootstrap_owner(owner_email text, workspace_name text) returns uuid language plpgsql as $$
declare existing_workspace uuid; created_workspace uuid; created_principal uuid;
begin
  select workspace_id into existing_workspace from app_identity_bindings where provider = 'supabase-email' and provider_subject = owner_email;
  if existing_workspace is not null then return existing_workspace; end if;
  insert into app_workspaces(name) values (workspace_name) returning workspace_id into created_workspace;
  insert into app_principals(workspace_id, kind, display_name) values (created_workspace, 'human', owner_email) returning principal_id into created_principal;
  insert into app_identity_bindings(workspace_id, principal_id, provider, provider_subject, verified_at) values (created_workspace, created_principal, 'supabase-email', owner_email, now());
  insert into app_memberships(workspace_id, principal_id, role) values (created_workspace, created_principal, 'owner');
  return created_workspace;
end;
$$;
commit;
