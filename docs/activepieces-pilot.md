# Activepieces connector trial

This is an isolated, operator-run experiment for
[ENG-129](https://linear.app/driftward/issue/ENG-129).
It invokes published Activepieces community connector code without running
Activepieces Server or using its enterprise embedding SDK. It is not connected
to Capykit's hosted API, browser, database, or production credentials.

## Run it

From the repository root, using Node 22 or later:

```sh
npm --prefix scripts/activepieces-poc ci --ignore-scripts
npm --prefix scripts/activepieces-poc run demo
npm --prefix scripts/activepieces-poc test
```

The demo invokes the actual GitHub and Google Drive action implementations. Nock
intercepts their HTTP requests, verifies exact paths and bearer headers, and
disables other network requests in each connector subprocess. The displayed
issue and document are fixtures, not connected account data. The same adapter
and actions are used in the optional live probe.

The example also demonstrates foreign-workspace, ungranted-principal, revoked
grant, and disconnected-account denials. Tests additionally cover in-flight
revocation, resource restrictions, expiry, input mutation, provider failures,
credential suppression, output limits, and execution deadlines.

The experiment has its own package lock and dependencies. Nothing is added to
the hosted image or the published Capykit package. CI installs and tests the
experiment separately on Node 22.

To run in a disposable container:

```sh
docker build -t capykit-activepieces-poc scripts/activepieces-poc
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m \
  capykit-activepieces-poc
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m \
  capykit-activepieces-poc node --test test.mjs
```

## What is reused

<!-- markdownlint-disable MD013 -->

| Provider | Pinned npm package | Action | Result |
| --- | --- | --- | --- |
| GitHub | `@activepieces/piece-github@0.9.0` | `get_issue_ai` | Issue number, title, state |
| Google Drive | `@activepieces/piece-google-drive@0.11.0` | `drive_get_file` | File ID, name, MIME type |

<!-- markdownlint-enable MD013 -->

Each successful action reads one resource. Bundled HTTP libraries may retry
transient failures; the process deadline bounds the whole action, not the
number of HTTP attempts. We deliberately use a single issue read: the upstream
issue-list action automatically follows all pages, whereas
Capykit's planned issue-review operation has its own limits. This trial does
not implement or claim compatibility with `github.issues.list.v1`.

The GitHub bundle has no external npm dependencies. The Drive bundle has one,
`@zip.js/zip.js`; both bundles include other libraries internally. The trial
adds Nock for tests and the fixture demo. A clean npm audit does not audit all
code embedded inside those bundles.

The npm release provenance (`gitHead`) points to these upstream commits:

- GitHub:
  [`497a895`](https://github.com/activepieces/activepieces/tree/497a895de1289aba895a7a1cd2dbd34912e8b9d6/packages/pieces/community/github)
- Drive:
  [`57e3121`](https://github.com/activepieces/activepieces/tree/57e31211c41c40127458c6176c613704ba6d7819/packages/pieces/community/google-drive)

The root licenses at both commits were checked and match. Their community
directories are MIT licensed; enterprise directories are excluded. The complete
notice is retained in
[LICENSE.activepieces](../scripts/activepieces-poc/LICENSE.activepieces).
Third-party notices inside installed bundles remain intact. No enterprise code
or embedding SDK is included.

## Connection and permission fit

The packages accept an OAuth-shaped context containing only an access token.
They do not need a running Activepieces service for these two actions. They also
do not perform Capykit's login, tenant authorization, OAuth onboarding, credential
refresh, or grant management for us.

The trial policy uses an in-memory connection and one explicit, current grant
binding a principal, workspace, connection, action, resource, and expiry. Human
and agent examples use the same invocation path. Ownership alone does not grant
execution. Foreign connection IDs are not disclosed. Access is rechecked before
releasing results, so a revoked grant or changed connection suppresses an
in-flight result. A sent provider request cannot be recalled.

This context comes from the trusted demo or operator, not a remote caller. It is
not a production authentication implementation. ENG-124 must resolve identity
and authoritative grants in PostgreSQL; ENG-125 must own run records, usage,
resource limits, and isolated execution. Do not expose `invoke()` directly as an
HTTP or MCP endpoint with caller-supplied context.

The connector runs in a fresh process with an empty environment, discarded
stdout/stderr, a 128 MiB V8 heap limit, and a 15-second deadline. Outputs are
limited to selected fields and bounded strings. Raw upstream exceptions, headers,
and response bodies never cross the adapter. This process boundary is not an OS
sandbox for arbitrary or user-authored code. Only the two pinned actions are
eligible; arbitrary actions, URLs, custom API calls, writes, and triggers are not.

### GitHub

The package's default OAuth definition asks for broad repository, organization,
webhook, and gist scopes. Its built-in App authentication mints installation
tokens without Capykit's selected-repository restriction. Neither mechanism is
used here.

The production integration should obtain an ephemeral token through ENG-123's
`ConnectionStore.withInstallationToken`, retain Issues-read and Metadata-read on
exact repository IDs, call its access check before each request, and let that
store revoke the token in `finally`. Passing that token as `auth.access_token`
works with the connector's bearer-token interface in the controlled test. A
real installation-token read remains unverified. The bundles have no shared
Capykit authorization hook: retries and more complex actions need request-level
mediation before production use. Production must also resolve
the permitted repository ID to its current name rather than trust an arbitrary
owner/repository string.

### Google Drive

The package's default OAuth definition asks for full Drive access and email.
Do not copy that scope list into Capykit. This metadata-only trial needs an
appropriately scoped token; `drive.metadata.readonly` is a candidate for reading
metadata across a consenting account, while a Picker-based `drive.file` flow
would limit access to selected files but also carries write capability for them.
Choose the product consent model before implementing onboarding.

The read action passes `supportsAllDrives=true` and returns default file metadata.
It does not need a refresh token, client secret, service-account key, or file
content. Capykit would still need its own Google OAuth app, consent/callback flow,
encrypted credential storage, refresh/reconnect handling, and durable per-file
authorization. See Google's
[scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Optional real-account probe

Use only a fresh credential dedicated to this Capykit trial, with consent for the
exact resource. Do not copy Factory, Hermes, Codex connector, or host CLI tokens.
The probe reads only these explicit environment variables:

- `CAPYKIT_POC_GITHUB_TOKEN`: short-lived, selected-repository GitHub installation
  token with Issues-read, or a dedicated fine-grained token for the test repo.
- `CAPYKIT_POC_GOOGLE_TOKEN`: short-lived Google access token authorized to read
  metadata for the specified test file.

After securely injecting the relevant variable, run one of:

```sh
npm --prefix scripts/activepieces-poc run live -- github OWNER/REPO ISSUE_NUMBER
npm --prefix scripts/activepieces-poc run live -- google-drive FILE_ID
```

Never put tokens in command arguments, files in the repository, or shared output.
The probe prints only connector identity, transport, and success; it does not
print private titles or names. It uses the operator's explicit invocation as
authority for this single test. It is not evidence of hosted user/agent login or
stored grants. Missing credentials fail closed with the variable name. No OAuth
tokens are acquired, persisted, or refreshed by the probe.

## Finding and remaining evidence

The actual connector code works for both selected actions with controlled HTTP
responses. Reuse is promising for reducing provider-specific action code. It
does not, by itself, solve the connection lifecycle that motivated the vendor
evaluation. Activepieces' supported embedded builder/user provisioning is an
[enterprise feature](https://www.activepieces.com/docs/embedding/overview).

The next product step is to wire the GitHub adapter behind the existing
connection-token seam and authoritative grants after ENG-124, then validate a
real read and revocation. Google needs an explicit consent/scope decision and
credential lifecycle before it belongs in the hosted catalog. Keep those gates
visible rather than presenting the fixture trial as a connected web integration.

Real OAuth setup, live account reads, persisted tenant isolation, hosted browser
execution, and an external agent's authenticated use remain unverified by this
experiment. Neither dedicated provider credential was available to this trial.
