# Hosted capability library

The console lets an active human workspace owner create skills and functions,
upload a draft, inspect its inventory/digest/contract, and publish an immutable
version. Complete bytes live in private PostgreSQL `bytea` records. Rebuilding
the application never changes a stored artifact. This is the ENG-122 slice;
publishing does not grant execution or recipient access.

## Web flow

1. Sign in, create a capability, and choose **Skill** or **Function**.
2. Select a complete skill folder containing `SKILL.md`, or a function's single
   `index.mjs`. A downloaded `.capykit.json` artifact can also be imported.
3. Review executable flags. Browser file pickers do not expose Unix permission
   bits, so set them explicitly for scripts; imported manifests preserve them.
4. Choose a version, save the draft, and inspect all paths, sizes, SHA-256 values,
   the bundle digest, and the fixed contract where applicable.
5. Publish that reviewed digest. Download the exact version from its version list.
   A change requires a new version. Identical repeated publish requests are
   idempotent; an existing version cannot be overwritten.

Downloads are JSON regular-file manifests with canonical base64 content and
executable flags. They include the capability identity, exact version, verified
digest, contract, and usage guidance. Decode each file into its relative path in
a new directory; read `SKILL.md` before using any supporting script. Downloads
and publication never execute code. Already downloaded bytes cannot be recalled.

From a built source checkout, unpack a download into a **new** directory:

```sh
node scripts/unpack-hosted-artifact.mjs download.capykit.json ./my-skill
```

The helper verifies the complete manifest and digest before writing, restores
binary bytes and executable flags, refuses existing destinations, and never runs
the contents. Load the resulting skill folder in your chosen agent environment.

## HTTP contract

All endpoints use the existing verified bearer token or HttpOnly session cookie.
Cookie writes also require the same origin and `x-csrf-token`.

| Method and path | Request / result |
| --- | --- |
| `GET /v1/capabilities` | `{capabilities: [...]}` within the current workspace |
| `POST /v1/capabilities` | `{slug, name, kind}` creates a stable UUID |
| `GET /v1/capabilities/:id` | Header, draft summary, and published summaries |
| `PUT /v1/capabilities/:id/draft` | `{version, artifact: {files: [...]}}` |
| `POST /v1/capabilities/:id/publish` | `{version, digest}` binds the inspected draft |
| `GET /v1/capabilities/:id/versions/:version/download` | Protected complete manifest attachment |
| `DELETE /v1/capabilities/:id` | Invalidates the capability and removes its bytes |

Each uploaded file declares exactly `{path, type: "file", executable,
contentBase64}`. There are no archive links or extraction hooks. Limits are 512
files, 8 MiB per skill file, and 32 MiB total decoded bytes. Paths must be portable,
relative, NFC-normalized, at most 1,024 characters and 33 components deep. The API
rejects links, unsupported types, credential files, detected secrets, path/case
collisions, invalid base64, and incomplete skill metadata. It processes at most one
large upload, publication, or download per API process; another transfer receives `ARTIFACT_BUSY` and can retry.

Function artifacts contain exactly one UTF-8 ESM `index.mjs`, at most 1 MiB,
exporting an async `handler`. Acorn parses syntax without evaluating it. Imports,
re-exports, dependencies, and uploaded replacement schemas are rejected. The
application-owned `github.issues.list.v1` contract is stored alongside each
version and included in its digest. Its schema and pagination semantics are
visible in the console. Actual provider requests and isolated execution belong
to ENG-123 and ENG-125.

## Persistence and authorization

Migration `003_hosted_capabilities.sql` replaces the empty foundation placeholder;
it refuses to discard unexpected existing rows. Compound workspace foreign keys,
version uniqueness, immutable records, and transaction-scoped RLS protect the new
tables. Upload bytes, metadata, draft references, and audit records commit in one
transaction. Replacement removes the old draft in that transaction; no separate
object-storage garbage collector is needed. Publication verifies every file
before inserting the immutable version. Downloads verify inventory, individual
hashes, contract, and aggregate digest before serving any bytes.
Digest ordering follows the portable bundle's `en-US` path order, with a raw
string comparison breaking ties between distinct Unicode paths.

`CapabilityStore.transaction` is the current authorization seam. It rechecks the
verified identity binding, workspace, principal, membership, and owner role from
PostgreSQL for every operation. A foreign workspace ID is hidden with 404;
forbidden actions on an in-workspace ID return 403. Members and agents have no
artifact access until ENG-124 explicitly adds exact-version grants. There is no
anonymous storage route, signed URL, or browser database credential.

Deletion marks the capability unavailable and removes file bytes atomically.
Version/digest metadata and non-content audit records remain. Existing downloads
cannot be recalled, and backups retain their historical bytes until the operator
removes those backups. This staging stack has local protected backups only; it
does not claim off-host backup or automatic retention. Before restoring an old
backup, reconcile deletions/revocations so the restore does not re-enable access.

## Upgrade and verification

Fresh Compose volumes apply all three migrations in one transaction. For an
existing deployment, take and restore-test a protected PostgreSQL backup first,
then apply **only migration 003** using the schema owner in a transaction with
`ON_ERROR_STOP=1`. Roll out the new application image after the migration commits.
Do not reset volumes. Keep the previous image for application rollback; preserve
the added tables when rolling back the application.

Run `npm run check` for lint, types, unit, build, package, schema, and secret checks.
Set `CAPYKIT_TEST_POSTGRES_URL` to an **isolated disposable** PostgreSQL database
to include the real database and HTTP integration tests. Never point this variable
at a live workspace. The integration checks exercise complete binary/permission
round trips, reopened API processes, transaction failure, immutable publication,
corruption, RLS, two-workspace substitution, and current access revocation.

ENG-124/126 must extend the same seam with exact-version recipient retrieval,
key/grant expiry and revocation, both authentication paths, and tests proving that
publishing a newer version never expands an existing grant. Those integrations
are deliberately denied until implemented.
