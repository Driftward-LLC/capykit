#!/bin/sh
set -eu

# Hex passwords can be used unchanged in both SQL and PostgreSQL connection URLs.
for password in "$CAPYKIT_DB_PASSWORD" "$CAPYKIT_AUTH_DB_PASSWORD"; do
  case "$password" in
    ''|*[!0-9a-fA-F]*) echo 'Generate database passwords as hexadecimal strings.' >&2; exit 1 ;;
  esac
  [ "${#password}" -ge 32 ] || { echo 'Database passwords need at least 32 hex characters.' >&2; exit 1; }
done
unset password

# The official PostgreSQL entrypoint runs this only for an empty data volume.
# Keep migrations and permissions atomic; never put passwords in psql arguments.
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv api_password CAPYKIT_DB_PASSWORD
\getenv auth_password CAPYKIT_AUTH_DB_PASSWORD
begin;
set local log_min_error_statement = 'panic';
revoke all on database capykit from public;
revoke all on schema public from public;
create role capykit_auth login nosuperuser nocreatedb nocreaterole
  noinherit noreplication nobypassrls password :'auth_password';
create schema auth authorization capykit_auth;
alter role capykit_auth set search_path = auth;
grant connect on database capykit to capykit_auth;

\i /opt/capykit/migrations/001_hosted_workspace_identity.sql
\i /opt/capykit/migrations/002_hosted_database_access.sql
\i /opt/capykit/migrations/003_hosted_capabilities.sql
\i /opt/capykit/migrations/004_hosted_connections.sql

create role capykit_api login nosuperuser nocreatedb nocreaterole
  inherit noreplication nobypassrls password :'api_password';
grant capykit_runtime to capykit_api;
grant connect on database capykit to capykit_api;
alter role capykit_api set search_path = public;
commit;
SQL
