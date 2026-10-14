# Connect an agent safely

Agents identifies the caller. Apps identifies the provider account that caller
may use. Matching names do not connect these identities or inherit permissions.
Apps / Agents / Actions are the primary navigation. Functions and People access
remain available under Functions & people access.

## Returning users and lost keys

1. Open Agents and choose the existing identity by name and metadata ID.
2. Review active keys, collapsed inactive history, exact grants and expiry.
   Selected agents lead with their stable name and short metadata ID, separate
   client status, Continue setup, compact keys and exact access cards. Setup
   forms and key history stay collapsed until requested; exact IDs remain
   available in each card and replacement confirmation.
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

Personal sharing retains its pending/uncertain guard above app-view lifetime,
scoped to the signed-in account/workspace and personal connection ID. All apps,
reopening the app, and switching accounts do not release an outstanding write.
A sharing read cannot run while that account's write is pending. Definite 4xx
denials retain their permission, connection or CSRF explanation and clear consent;
transport loss, timeouts, server errors and malformed success responses pause
submission. Reconciliation reads never retry the POST. Only a newly recorded
grant matching the attempted recipient, action and expiry resolves uncertainty;
absence from an early read is not proof that an ambiguous write failed.
These are in-memory guards, not cross-tab/server idempotency. No backend authority
or production grant behavior is changed.

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
intercept every request and record only safe scenario results, never HAR, DOM
dumps or one-time keys. Coverage includes 320, 375, 430 and 1440 CSS-pixel
layouts, keyboard focus, touch dimensions, duplicate names, exact rotation,
clipboard rejection, missing responses, uncertainty, navigation/reload recovery,
workspace scope, personal review and unknown client readiness. Personal sharing
regressions use actual All apps navigation before write commit, per-account locks,
definite permission/connection/CSRF denials and uncertain-response reconciliation.
Optional `CAPYKIT_AGENT_VISUAL_DIR` captures metadata-only selected-agent images,
only after checking no one-time credential is present.

For real local API and database verification, set `CAPYKIT_TEST_POSTGRES_URL` to
an isolated disposable PostgreSQL database. Never point it at production. The
suite creates isolated schemas and fixture identities, then removes its schemas.
With Playwright configured and console assets built, it also exercises cookie/CSRF
key issuance and same-identity rotation through the actual HTTP API in Chromium,
plus personal-sharing navigation and denial checks:

```sh
npx vitest run tests/connector-actions-db.test.ts tests/personal-connections.test.ts
```

`scripts/test-agent-api.mjs` and `scripts/test-personal-share-api.mjs` are invoked
by those suites, not operator workflows. Real APIs run against disposable local
PostgreSQL. Deliberate missing-key/lost-response transport faults, a held POST
before forwarding, and invalid CSRF/forbidden-action inputs exercise recovery.
Authentication uses fixture identities; provider transport is stubbed. The
personal suite verifies exactly five grants were recorded: four viewport cases
and one committed lost-response case, with none added by the two real denials.

Evidence categories:

- Fixture browser and helper checks: exercised locally; no live backend claims.
- Isolated actual API/PostgreSQL/browser: exercised with fixture authentication
  and sentinel credentials, including cross-workspace denial, CSRF, revocation,
  expired keys, concurrent issuance, unchanged grants and unrelated credentials.
- Deployed product and live providers: not verified; no production changes.
- Authenticated external client: no recorded evidence, always Not yet verified.
- Selected Linear visual attachment `3bc9c8a0-4cef-4472-aad4-60a7539535d0`:
  retrieved through authenticated Linear attachment metadata and image access
  during this repair. Metadata-only 375px and desktop renders were inspected
  against its name/status/setup/key/access/history hierarchy and dark-green/mint
  styling. Browser checks cover 320/375/430px and desktop with intact navigation.
  This is a hierarchy comparison, not pixel-identical or physical-device approval.
- Independent final review remains Astra pass 2 on the repaired exact head; this
  repair does not run another independent review loop or grant merge approval.

This draft does not close broader ENG-124/ENG-126 work and does not authorize
merge, deployment, production key replacement or provider installation.
