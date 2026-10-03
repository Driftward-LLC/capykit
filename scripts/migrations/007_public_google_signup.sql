-- Schema-owner migration. The API receives only EXECUTE on this narrow operation;
-- it does not gain INSERT/UPDATE authority on identity or membership tables.
do $$
declare target_schema text := current_schema();
begin
  execute format($definition$
    create or replace function %I.provision_google_workspace(auth_subject uuid, verified_email text)
    returns uuid language plpgsql security definer
    set search_path = %I, pg_catalog, pg_temp
    as $function$
    declare
      existing record;
      workspace uuid;
      principal uuid;
    begin
      if auth_subject is null or auth_subject = '00000000-0000-0000-0000-000000000000'::uuid
        or verified_email is null or length(verified_email) > 254
        or verified_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
        raise exception 'Invalid verified identity' using errcode = '22023';
      end if;
      perform pg_advisory_xact_lock(hashtextextended('capykit-signup:' || auth_subject::text, 0));
      select p.workspace_id, p.kind, p.active as principal_active, b.verified_at,
             m.active as membership_active, w.active as workspace_active
        into existing
        from identity_bindings b
        join principals p on p.id = b.principal_id
        join workspaces w on w.id = p.workspace_id
        left join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
       where b.provider = 'gotrue' and b.provider_subject = auth_subject::text;
      if found then
        if existing.kind <> 'human' or not existing.principal_active
          or existing.verified_at is null or existing.membership_active is distinct from true
          or not existing.workspace_active then
          raise exception 'Existing identity has no active human membership' using errcode = '42501';
        end if;
        update identity_bindings set email = lower(verified_email)
         where provider = 'gotrue' and provider_subject = auth_subject::text;
        return existing.workspace_id;
      end if;
      workspace := gen_random_uuid();
      principal := gen_random_uuid();
      insert into workspaces(id, slug, name) values(workspace, 'workspace-' || workspace::text, 'My workspace');
      insert into principals(id, workspace_id, kind, display_name) values(principal, workspace, 'human', verified_email);
      insert into identity_bindings(principal_id, provider, provider_subject, email, verified_at)
        values(principal, 'gotrue', auth_subject::text, lower(verified_email), now());
      insert into workspace_memberships(workspace_id, principal_id, role) values(workspace, principal, 'owner');
      return workspace;
    end;
    $function$;
  $definition$, target_schema, target_schema);
  execute format('revoke all on function %I.provision_google_workspace(uuid, text) from public', target_schema);
  execute format('grant execute on function %I.provision_google_workspace(uuid, text) to capykit_runtime', target_schema);
end $$;
