# ADR 0003: Explicit portable environment profiles

- Status: Accepted
- Date: 2026-09-21
- Decision owner: Driftward LLC
- Extends: [ADR 0001](0001-product-contract.md)
- Preserves: [ADR 0002](0002-registry-trust-boundaries.md) discovery and
  credential boundaries

[ADR 0004](0004-hosted-capability-platform.md) establishes the hosted product
direction. These profiles remain an optional local setup and sharing facility;
their manual connection instructions do not define hosted connection management.

## Context

On 2026-09-21, the user explicitly requested portable setup that can move a
useful collection of tools and skills between agent environments. A registry
alone describes capabilities but does not carry a skill's support files, install
its command dependencies, or explain environment-specific connection steps.

ADR 0001 made installing or updating described tools a v0.1 non-goal. This
decision extends that boundary with an explicit CLI profile application step.
It does not turn catalog ingestion, discovery, or the MCP server into an
installer or general executor.

## Decision

An environment profile is a versioned local folder with a strict
`capykit.environmentProfile.v0.1` manifest, one capability registry, complete
skill directories, optional pinned npm dependencies, and manual connection
instructions. It is shared using ordinary Git revisions or archives. Importing
a remote repository or extracting an archive remains outside the profile API.

`profile inspect` validates the bundle and reports destinations, dependency
plans, command availability, and manual steps without mutating the environment.
`profile apply` is the explicit mutation boundary. It validates and stages the
bundle, checks source and destination conflicts, optionally installs pinned npm
dependencies when `--install-tools` is supplied, places skill files, and
activates the registry source last.

Each profile version has a managed snapshot identified by a digest of the
normalized manifest, file bytes, and executable flags. The installed registry
rewrites bundled skill locations to their local destinations. A receipt records
profile ownership and destinations. Identical reapplication is accepted;
changed files or destinations under the same version are refused. A new version
can replace the active source while preserving the previous snapshot.

Skills normally remain inside the versioned snapshot. An explicit
`--skills-dir` may place them in a native agent skill root, but existing
directories must match exactly. An upgrade cannot overwrite different files
there, even if an earlier profile version created them. The operator selects a
new destination or resolves the difference manually.

Optional npm installation has a fixed argument contract: exact direct package
versions, an isolated per-profile/version prefix, `--ignore-scripts`, and a
retained lockfile. There are no profile-defined setup hooks, arbitrary installer
arguments, shell commands, or package lifecycle execution. Non-npm dependencies
and packages requiring lifecycle scripts remain manual setup. Direct pins do
not guarantee identical transitive dependency graphs across fresh environments.

The operator configures the agent to load the installed skills or connect to
the existing read-only MCP server, and adds the reported dependency bin path to
that agent's environment. Profile application does not edit all agent settings,
change shell startup files, or verify account access.

## Boundaries

Registry loading, CLI catalog reads, adapters, and MCP retain their discovery
roles. No install, profile apply, registered-tool invocation, or generic
execution operation is added to MCP. Profile content cannot activate itself or
change a source's approval state. Explicit CLI application adds the resulting
validated registry through the existing source configuration.

Profiles carry credential references and connection instructions, never
credential values, sessions, or cookies. Applying a profile does not resolve
authentication references or run login flows. The loader rejects detected
credential content, credential files, unsafe paths, symbolic links, and file
collisions before source activation. It preserves existing files on conflicts.

The fixed npm installer is a narrowly scoped exception to ADR 0001's
installation non-goal. It is not a generic execution gateway. ADR 0002's
prohibition on resolving catalog credentials and its read-only MCP contract
remain in effect.

## Consequences

- One reviewable folder can carry useful capability metadata and complete
  skills into a fresh environment without depending on a private host layout.
- Setup is reproducible at the profile-content and direct-package-version
  level. Dependency locks remain local; account access and native agent
  configuration remain environment-specific.
- Safe upgrades are straightforward with managed skill paths. Native skill
  roots require explicit conflict resolution when files change.
- A failed setup does not activate the new registry source. An isolated npm
  prefix can retain downloaded files for retry; it is not part of the immutable
  bundle snapshot.
- The feature is documented against local `node dist/cli.js` and
  `node dist/mcp.js` entrypoints until published in a Capykit release.

The operator workflow is documented in
[Portable environment profiles](../environment-profiles.md).
