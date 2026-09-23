-- Apply with the schema owner in the same transaction as migration 001.
-- The login/password belong in managed configuration, not this migration.
do $$ begin
  create role capykit_runtime nologin nosuperuser nocreatedb nocreaterole
    noinherit noreplication nobypassrls;
exception when duplicate_object then null;
end $$;

do $$
declare
  target_schema text := current_schema();
  table_name text;
  browser_role text;
begin
  if exists (
    select 1 from pg_roles where rolname = 'capykit_runtime'
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolcanlogin)
  ) then
    raise exception 'capykit_runtime must be an unprivileged NOLOGIN role';
  end if;

  execute format('revoke create on schema %I from public, capykit_runtime', target_schema);
  execute format('grant usage on schema %I to capykit_runtime', target_schema);
  foreach table_name in array array[
    'workspaces', 'principals', 'identity_bindings', 'workspace_memberships', 'capability_publications'
  ] loop
    execute format('alter table %I.%I enable row level security', target_schema, table_name);
    execute format('revoke all on table %I.%I from public, capykit_runtime', target_schema, table_name);
    foreach browser_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = browser_role) then
        execute format('revoke all on table %I.%I from %I', target_schema, table_name, browser_role);
      end if;
    end loop;

    if table_name <> 'capability_publications' then
      execute format('grant select on table %I.%I to capykit_runtime', target_schema, table_name);
      execute format('drop policy if exists capykit_runtime_read on %I.%I', target_schema, table_name);
      execute format('create policy capykit_runtime_read on %I.%I for select to capykit_runtime using (true)', target_schema, table_name);
    end if;
  end loop;
end $$;
