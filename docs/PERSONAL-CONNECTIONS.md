# Personal app accounts

New accounts belong to the person who connects them. Workspace owners cannot use
another person's private account. The owner can share an independently reviewed,
version-pinned action on that account with an active user or agent in their
workspace. Grants expire and are invalidated when the connection is
disconnected. Existing workspace-owned GitHub and Drive connections keep their
existing read-only behavior.

Capykit uses the MIT-licensed Activepieces Community server as a private
connection and action engine. It uses neither the enterprise embedding SDK nor
Activepieces cloud OAuth credentials. Only Capykit's API is exposed to
customers. One-shot execution uses a private disabled draft with an exact piece
version, tests only that action, then deletes the draft. Drafts are never
published; Activepieces removes their execution artifacts through its normal
deletion worker. The engine admin session, upstream references and provider
credentials remain on the backend.

## Operator configuration

The optional `connectors` Compose profile adds a pinned Community server and its
own PostgreSQL database. Its in-memory queue is appropriate for this
single-instance preview; do not scale it or run saved workflows. No engine or
database port is published. Strict network mode blocks piece requests to private
IP addresses; customer code, flow creation and upstream MCP are not exposed.

1. Create protected engine and database environment files. The engine needs
   `AP_POSTGRES_PASSWORD`, generated `AP_ENCRYPTION_KEY` (32 hex characters) and
   `AP_JWT_SECRET` (64 hex characters). The database file needs the matching
   `POSTGRES_PASSWORD`. Preserve all keys and the database in backups.
2. Start only `connector-postgres` and `connector-engine` with `--profile
   connectors`. Set `CAPYKIT_CONNECTOR_BOOTSTRAP=true` only during the initial,
   private service-account signup. Create the service account using the
   Community `/api/v1/authentication/sign-up` API, then disable bootstrap and
   recreate only the engine. Never expose the engine's signup or builder
   publicly.
3. Create `engine.json` in a protected directory mounted by both Capykit APIs.
   Set file owner to the container's node UID (1000), mode0600, directory
   mode0700. Example schema below uses placeholders, not usable credentials.
4. Set `CAPYKIT_CONNECTOR_CONFIG_DIRECTORY` to that directory and
   `CAPYKIT_PIECE_ENGINE_CONFIG_FILE=/var/lib/capykit/connectors/engine.json`.
   Apply migration009 as the database migration owner before recreating
   Capykit's APIs. Never grant browser roles direct table access.

```json
{
  "baseUrl": "http://connector-engine",
  "email": "connector-engine@accounts.invalid",
  "password": "operator-generated-service-password",
  "encryptionKey": "base64-encoded-32-byte-key",
  "oauthClients": {
    "@activepieces/piece-google-drive": {
      "clientId": "central-provider-client-id",
      "clientSecret": "central-provider-client-secret",
      "callbackPath": "/v1/connections/google/callback"
    }
  }
}
```

OAuth clients are registered centrally by Capykit's operator. Their authorized
redirect URLs must match each deployment's HTTPS origin and callback path. The
optional Google callback path reuses Capykit's existing registered URI; new
providers use `/v1/connections/personal/callback`. Users only choose their
provider account and approve consent. No customer creates an OAuth developer
client. OAuth authentication properties are denied by default. If a connector
requires host/environment properties, centrally set `allowedProps` to explicit
allowed values, such as `{"environment":["login","test"]}` after reviewing its
authorization and token URL construction. Customers cannot substitute arbitrary
token hosts. Each provider's scopes, testing/verification rules and account
restrictions still apply.

API-key, basic, custom and no-auth connectors use the corresponding protected
Capykit form. OAuth providers without central registration show setup pending;
catalog inclusion does not mean they are ready for sign-in. Connector runtime
versions must match the checked-in catalog. Updated upstream versions fail
closed until the snapshot is reviewed and updated.

## Actions and sharing

Apps → choose app → connect account → select action → enter inputs → run.
Actions may write data. Review the action before running; OAuth consent
describes the provider permissions. Share an action grants that action on that
exact account, currently for30 days in the UI. Disconnect removes runtime
credentials and immediately invalidates local grants; it does not remove the
user's provider-wide OAuth permission.

Agent MCP exposes `list_connections`, `list_connection_actions` and
`run_connection_action` using the same API and grant checks as the browser.
Native workspace tools remain available. Literal input values are allowed;
Activepieces template expressions and credential selectors are rejected. Audit
records include actor, account, action and grant IDs, never inputs, outputs or
secrets.

Revoking access prevents new runs and delivery of results from a run still in
progress. It cannot undo a provider mutation that already started. After a
timeout, inspect the connected app before retrying a write action.

The connector image applies a verified TLS transport patch because
Community0.92.1 pieces-common disables Node certificate validation. Both API and
engine transports enforce verification; an automated self-signed certificate
test covers global and per-request bypass attempts. Upstream raw logs are
disabled to avoid retaining provider error objects containing credentials.
Capykit's audit remains available. The preview limits engine execution-data
retention to one day and disables retries.
