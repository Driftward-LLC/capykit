# Connect an agent safely

Agents identifies the caller. Apps identifies the provider account that caller
may use. Matching names do not connect these identities or inherit permissions.
Functions and Access retain published-capability and people management.

## Returning users and lost keys

1. Open Agents and choose the existing identity by name and metadata ID.
2. Review active keys, collapsed inactive history, exact grants and expiry.
3. For a lost key, choose Replace this key on its exact metadata ID. Confirm
   which credential stops working. The principal, grants and unrelated keys
   remain unchanged. A revoked key cannot be rotated.
4. An agent with no unrevoked credentials can receive a key on the same
   principal. The API rejects this operation if an unrevoked key already exists;
   reload metadata and choose an exact replacement instead.
5. Save the one-time key in the client's secret manager. Clipboard failure leaves
   a selectable field for manual copying. Copying is not proof of saving: confirm
   secure storage before continuing.

Creating a new identity is separate. Same-name warnings link to existing agents;
duplicate names are permitted and never merged or deleted automatically.

Keys exist only in the one-time reveal state. Leaving the view, hiding the page,
reloading, or five minutes without interaction clears an unsaved reveal. A late
response after leaving is discarded. There is no plaintext recovery endpoint.
Do not include keys in browser storage, URLs, logs, telemetry or screenshots.

Missing or malformed keys and ambiguous network completion do not mean success.
Submission pauses until an explicit successful metadata reload. Inspect IDs
before a confirmed replacement; no mutation is replayed automatically. After a
full reload, inspect existing identities and key metadata before creating one.

## Exact access and client setup

Workspace grants require explicit recipient, action, connected account,
repository selection where applicable, expiry and review consent. Changing the
scope or refreshing metadata clears consent. The API retains ownership, tenancy,
CSRF, expiry and revocation enforcement. GitHub scope remains immutable repository
IDs, not matching names. Drive scope is account-accessible file metadata.

Apps exposes the same workspace identity and grant records within supported apps.
Personal-account sharing uses its existing separate grant service. Its review
explicitly warns that the grant covers the selected action across that account's
accessible resources, without per-repository restrictions. Use workspace grants
for exact GitHub repository limits. No automatic personal grant is created.

Expiry uses a native local-time input with an explicit timezone and 7-, 30- and
90-day presets. Future expiry is validated again before submission.

Client instructions contain placeholders only. The remote MCP command is
`capykit-mcp --remote`, configured with `CAPYKIT_BASE_URL` and `CAPYKIT_API_KEY`
through the client's secret manager:

- Workspace: `list_actions`, `get_action`, `run_action` with `id`, `connectionId`
  and `input`.
- Personal: `list_connections`, `list_connection_actions`,
  `run_connection_action` with `connectionId`, `action` and `input`.

Personal actions may change provider data. Never use them as an automatic
connection test. Provider credentials remain server-side.

## Readiness and bounded testing

Identity creation, credential validity, permission grants, provider availability
and authenticated external-client verification are separate facts. The current
metadata APIs provide no scoped, timestamped external-client evidence. Client
status therefore remains Not yet verified, including after saving a key, granting
access or a successful owner-browser test. This is not an access denial.

The optional owner-browser connection test reuses the existing read-only action
console. Select the exact connected account, repository and target before running
it. It uses the owner's browser session, not the agent's key or grants. It never
runs automatically and cannot prove executor connectivity.

## Verification and evidence limits

Run all normal repository checks without changing their commands:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
npm run check:schema
npm run check:secrets
```

After building, run the sanitized browser fixtures:

```sh
node scripts/test-agent-setup.mjs
```

Use an already-installed Playwright module and Chromium binary through
`CAPYKIT_PLAYWRIGHT_MODULE` and `CAPYKIT_CHROMIUM_PATH` when needed. Fixtures
intercept every request and record only safe scenario results, never screenshots,
HAR, DOM dumps or one-time keys. Coverage includes 320, 375, 430 and 1440 CSS-pixel
layouts, keyboard focus, touch dimensions, duplicate names, exact rotation,
clipboard rejection, missing responses, uncertainty, navigation/reload recovery,
workspace scope, personal review and unknown client readiness.

For real local API and database verification, set `CAPYKIT_TEST_POSTGRES_URL` to
an isolated disposable PostgreSQL database. Never point it at production. The
suite creates isolated schemas and fixture identities, then removes its schemas.
With Playwright configured and console assets built, it also exercises cookie/CSRF
key issuance and same-identity rotation through the actual HTTP API in Chromium:

```sh
npx vitest run tests/connector-actions-db.test.ts
```

`scripts/test-agent-api.mjs` is invoked by that suite, not an operator workflow.
Only its deliberate missing-key response defect is injected. Authentication uses
fixture identities; provider transport in the database suite is stubbed.

Evidence categories:

- Fixture browser and helper checks: exercised locally; no live backend claims.
- Isolated actual API/PostgreSQL/browser: exercised with fixture authentication
  and sentinel credentials, including cross-workspace denial, CSRF, revocation,
  expired keys, concurrent issuance, unchanged grants and unrelated credentials.
- Deployed product and live providers: not verified; no production changes.
- Authenticated external client: no recorded evidence, always Not yet verified.
- Selected Linear visual attachment: not retrieved through an authenticated
  attachment interface in this execution. Layout checks use existing Capykit
  tokens; a comparison against that attachment remains a draft-review gate.

This draft does not close broader ENG-124/ENG-126 work and does not authorize
merge, deployment, production key replacement or provider installation.
