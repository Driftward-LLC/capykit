# Portable environment profiles

Profiles provide local setup and sharing in the current implementation. The
[hosted product direction](adr/0004-hosted-capability-platform.md) places shared
connections, functions, and access management in the app; that backend is still
to be implemented.

A profile packages a capability registry, complete skill directories, pinned
optional tools, and connection instructions into a versioned folder. Share that
folder through Git or an archive, then inspect and apply it in each environment.
The resulting registry points to that environment's installed skill locations.

The checked-in [portable toolkit](../examples/portable-toolkit/profile.json)
includes a JSON review skill, its script and reference files, a Node.js
requirement, and an optional pinned Prettier installation.
The [portability pilot](profile-portability-pilot.md) records the two-environment
installation and CLI/MCP checks, including their limits.

## Try the local implementation

These commands use the local build because profile support is unreleased.
Run them from the Capykit checkout with Node.js 22 or newer:

```bash
npm ci
npm run build

node dist/cli.js profile inspect examples/portable-toolkit/profile.json \
  --config .capykit-example/registry-sources.json --json

node dist/cli.js profile apply examples/portable-toolkit/profile.json \
  --config .capykit-example/registry-sources.json --install-tools

node dist/cli.js tools search "JSON" \
  --config .capykit-example/registry-sources.json

node dist/cli.js tools show json-review --json --check \
  --config .capykit-example/registry-sources.json
```

`inspect` validates the bundle and reports destinations, command availability,
the npm installation plan, and manual connection steps. It does not write files,
install packages, or require npm to be present. It does not reserve destinations;
`apply` checks the active catalog and destination conflicts before activation.

`apply` writes an immutable managed snapshot and activates its registry source
after validation, skill placement, and any requested npm installation succeed.
Omit `--install-tools` to apply the registry and skills without installing npm
packages. Missing tools and unfinished connections remain visible in the report;
they do not imply the profile is fully usable.

| Option | Meaning |
| --- | --- |
| `--config <path>` | Select the registry sources configuration. Managed profile files and dependency prefixes live beside it. The default is `$XDG_CONFIG_HOME/capykit/registry-sources.json`, or `~/.config/capykit/registry-sources.json`. |
| `--skills-dir <path>` | Copy each skill to `<path>/<skill-id>` for an agent's native skill discovery. Choose this destination before the first apply. Without it, skills remain in the managed snapshot. |
| `--path <path>` | Set the executable search path used by the availability report. The profile's dependency bin directory is searched first. This option does not change the shell or agent's `PATH`, or npm's execution environment. |
| `--install-tools` | On `apply` only, install the declared exact npm package versions into the profile's isolated prefix. |
| `--json` | Return the structured plan or apply report, including destinations and `npm.binPath`. |

## Make the profile usable by an agent

Applying a profile sets up its files and catalog source. Configure each agent
environment to load the reported skill directories or connect to Capykit's MCP
server using the same sources configuration. For the local build:

```bash
node dist/mcp.js --config .capykit-example/registry-sources.json
```

In an agent's MCP settings, use `node` as the executable and absolute paths to
`dist/mcp.js` and the configuration file as arguments. The report's `mcp`
field points to the server alongside the running CLI when available, so it
uses the same build. A standalone CLI without that server falls back to
`capykit-mcp`, which must be installed separately from a release supporting
configured sources. MCP keeps
its existing visibility and context filters.

If you installed dependencies, add the reported `npm.binPath` to the `PATH` of
every shell or agent process that will invoke them. For the example above, from
the checkout on Linux or macOS:

```bash
export PATH="$PWD/.capykit-example/profile-tools/portable-toolkit/1.0.0/node_modules/.bin:$PATH"
```

On Windows, add the same reported directory to the relevant process or user
`Path`. A running agent may need its launch environment updated and restarted.
Capykit does not edit agent settings or shell startup files. A command found on
`PATH` has not had its version or account access verified by the profile report.

For native skill discovery, pass `--skills-dir` to both inspection and the first
apply, using a skill directory supported by that particular agent. This is an
explicit destination, not automatic configuration of every installed agent.

Complete the profile's connection instructions separately in each environment.
Authentication values, login sessions, cookies, and provider setup are not
copied by a profile.

## Author and share a bundle

Keep the manifest, registry, and skills together:

```text
portable-toolkit/
  profile.json
  registry.json
  skills/
    json-review/
      SKILL.md
      scripts/check-json.mjs
      references/checklist.md
```

The manifest uses `format: "capykit.environmentProfile.v0.1"`, a lowercase
`id`, an exact `version` such as `1.0.0` or `1.1.0-beta.1`, a `name`, and a
bundle-relative `registry` path. Optional `skills`, `tools`, and `connections`
arrays default to empty. See the
[complete manifest](../examples/portable-toolkit/profile.json) and
[registry](../examples/portable-toolkit/registry.json).

Each skill entry declares its `id` and directory `path`. Its directory basename
and `SKILL.md` frontmatter `name` must match that id, and its frontmatter must
include a description. Supporting scripts, references, and other files are
copied with the skill; no setup hook or bundled script runs during apply.
Every `skill` interface in the registry must use the exact bundled location
`<declared-skill-path>/SKILL.md`. Capykit rewrites those locations in the
installed registry.

Tools declare a single executable `command`, optional installation
`instructions`, and optionally `npm: { "package": "name", "version": "1.2.3" }`.
Scoped package names are supported. Non-npm tools are manual requirements.
Connections declare an `id`, `summary`, and `instructions`; those instructions
are shown to the operator and never executed as setup commands.

Use portable relative paths with letters, digits, periods, underscores, and
hyphens. The root `profile.json` name is reserved for the normalized snapshot
manifest. Skill roots cannot overlap, and the registry must live outside them.
The loader rejects unsafe paths, links, conflicting destinations, credential
files, and detected credential content. Keep credentials and dependency
directories out of the shared folder. Profiles support at most 64 entries in
each manifest array, 512 bundled files, 8 MiB per file, and 32 MiB overall.

Commit or archive the whole folder, preserving executable permissions where
supported. On another machine, check out the chosen Git revision or unpack the
archive, inspect its manifest, and apply it with that environment's configuration
and optional skill destination. Applying does not fetch Git repositories or
unpack archives for you.

## Dependency installation and versions

`--install-tools` uses a fixed npm installation with `--ignore-scripts`, exact
direct package versions, and a retained `package-lock.json`. Packages live in
`profile-tools/<profile-id>/<version>/` beside the sources configuration, with
executables under `node_modules/.bin`. It does not install globally or into the
project's own dependencies. npm must be available for installation; Windows
automatic installation requires Node's bundled npm CLI.

Pins cover direct dependencies, not a shared lock of the whole transitive graph.
Fresh installations in two environments can therefore resolve different
transitive versions. Each environment retains its own npm lockfile. Packages
that need lifecycle scripts require manual installation using their documented
procedure. Capykit does not run those scripts or accept arbitrary installer
commands from a profile.

## Reapply or upgrade

The managed snapshot lives at `profiles/<profile-id>/<version>/` beside the
sources configuration. It contains the bundle, a registry with local skill
locations, and an installation receipt. Its digest covers the normalized
manifest, registry and skill bytes, and executable flags. Reapplying the same
version and destinations accepts identical files. Changed content, executable
flags, destinations, or local edits are not overwritten; publish a new profile
version instead.

With the default managed skill locations, applying a new version creates a new
snapshot and switches the profile's source to it after successful setup. Older
snapshots remain on disk. If the npm version directory changed, update the
agent's dependency `PATH` to the new reported location.

With an explicit `--skills-dir`, an existing skill directory must already match
the new files. Different files are refused even when a previous version of this
profile installed them. Choose a new skills destination or resolve that
directory manually before applying the upgrade. No existing skill directory is
silently replaced.

If setup fails, the new source is not activated. A previous active version stays
active; downloaded npm dependencies may remain in their isolated prefix for a
retry. Profile setup is an explicit CLI action. Catalog reads and MCP requests
continue to discover metadata without installing or invoking tools.
