# Layered registry loading

Capykit resolves registry sources with one fixed precedence order:

1. `builtin` — public records shipped with Capykit.
2. `organization` — records shared by an organization.
3. `host` — records specific to one machine or runtime host.
4. `user` — personal records for the current user.

The order in which callers provide sources does not affect the result. Sources
within a layer are ordered by source ID only to make loading and diagnostics
repeatable; two sources in the same layer may not define the same tool ID.

## Identity and overrides

A tool's `id` is its stable catalog identity. When a higher-precedence source
redefines an existing ID, that source must include the ID in its `overrides`
list. An implicit collision is an error, as is an override with no
lower-precedence target. These rules make replacements reviewable and catch
misspelled or stale configuration.

```ts
import { loadRegistryCatalog } from "@driftward/capykit/core";

const catalog = await loadRegistryCatalog([
  {
    id: "capykit-public",
    layer: "builtin",
    type: "file",
    root: "/opt/capykit",
    path: "public.registry.json",
  },
  {
    id: "workstation",
    layer: "host",
    type: "file",
    root: "/etc/capykit",
    path: "host.registry.json",
    overrides: ["github"],
  },
]);
```

Each resolved record includes provenance for the winning source and every
record it explicitly replaced. Provenance contains the source ID, layer,
canonical URI, assigned trust tier, immutable revision or digest identity,
registry ID, read timestamp, and a SHA-256 checksum of the exact source bytes.
`builtin` sources are marked `bundled`; organization, host, and user sources are
marked `operator-approved`. Registry content cannot change those assignments,
and provenance never contains credentials.

## Source types and cwd independence

Local-file sources require an absolute configured `root` and a root-relative
`path`. Capykit canonicalizes both before opening the file and rejects parent
traversal, symlink escapes, and non-regular files. Git-backed sources require
an absolute local `repository`, a revision, and a repository-relative POSIX
`path`. Capykit resolves the revision to an immutable commit before reading it
with `git show <commit>:<path>`; it does not silently use work-tree content.
The same configuration therefore resolves identically regardless of process
cwd or uncommitted Git changes.

Use `registryPath(explicitAbsoluteBase, relativePath)` to construct a contained
path from trusted configuration. It rejects absolute paths and parent traversal
and never consults `process.cwd()`.

Registry content is treated as data. Loading rejects credential-like keys and
values with redacted, field-specific errors before any source enters the
effective catalog.

## Approved source operations

Operators manage approved sources with `capykit registry source ...`. The source
configuration defaults to `.capykit/sources.json` and can be overridden with
`--config <path>` for host-local or repo-scoped automation.

```bash
capykit registry source add local team \
  --layer organization --root /opt/capykit --path team.registry.json
capykit registry source add git private \
  --layer host --repository /srv/registry --revision main --path registry.json
capykit registry source add http public \
  --layer builtin --url https://registry.example.com/capykit/registry.json
capykit registry source sync
capykit registry source inspect
capykit registry source remove team
```

`sync` records a lock for every configured source. Local sources lock the exact
source byte digest, Git sources resolve the configured revision to an immutable
commit SHA before reading with `git show`, and HTTP sources require HTTPS URLs
without credentials or fragments. HTTP source bytes are cached below the config
directory so `capykit registry source sync --offline` can verify and reuse the
previous approved bytes without network access. Config writes are atomic: a
fully validated replacement is written to a temporary file, fsynced, and renamed
over the previous config so failed updates leave the prior registry usable.

`inspect` prints machine-readable precedence and provenance, including layer
rank, lock state, source URI, revision, checksum, and the effective catalog when
all configured sources are loadable. Higher-precedence overrides still require
explicit `--override <tool-id>` declarations.

Load failures identify the source. Conflict errors expose the tool ID and both
source IDs, then state whether to add an explicit override, remove a duplicate,
or move a record to a different layer.
