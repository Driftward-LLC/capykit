# ADR 0001: Capykit product contract

- Status: Accepted
- Date: 2026-08-03
- Decision owner: Driftward LLC
- Linear issue: [ENG-2](https://linear.app/driftward/issue/ENG-2/define-product-contract-final-name-and-v01-scope)

## Context

Agents on the same host or inside the same company often discover tools through
different shell paths, MCP configurations, skills, and platform-specific
instructions. The result is duplicated setup and inconsistent knowledge about
what a tool does, how to invoke it, and whether it is healthy.

Capykit provides one portable, machine-readable capability catalog. It is a
standalone product rather than a Driftward host script so other users and agent
platforms can install it without adopting Driftward infrastructure.

## Product identity

| Surface | Name |
| --- | --- |
| Product | Capykit |
| Canonical source repository | `Driftward-LLC/capykit` |
| CLI and executable | `capykit` |
| npm package | `@driftward/capykit` |
| MCP server | `capykit` |
| MCP service | `capykit-mcp` |
| Container image | `ghcr.io/driftward-llc/capykit` |
| Default config directory | `~/.config/capykit` |
| Private registry repo | `Driftward-LLC/driftward-capykit-registry` |

The package name was unclaimed in the public npm registry when this decision
was accepted. Publication remains a separate release task.

Capykit honors `$XDG_CONFIG_HOME`; when it is set, the default config directory
is `$XDG_CONFIG_HOME/capykit` instead.

## Ownership boundary

The Capykit application repository owns:

- The versioned capability metadata schema.
- Registry loading, validation, discovery, and source-management behavior.
- The CLI, read-only MCP server, generated adapters, documentation, and release
  artifacts.
- Public examples and fixtures that contain no Driftward-only information.

The private Driftward registry repository will own:

- Driftward-specific capability records and source configuration.
- References to approved environment variable names, credential providers, or
  protected file locations, but never credential values.
- Driftward policy overlays that are data, not changes to Capykit code.

`Driftward-LLC/driftward-host` owns host-level bootstrap on the Driftward VPS,
including host package installs and secret-file placement. It consumes released
Capykit artifacts and the private registry;
it does not become Capykit's application repository.

Private records must never be committed to the public Capykit repository or
published in the npm package, container image, standalone executables, public
fixtures, or Capykit release logs.

## Implementation and platforms

Capykit will be implemented in TypeScript and target Node.js 22 or newer. The
codebase will use strict type checking and publish compiled JavaScript rather
than requiring users to install a TypeScript runtime.

The v0.1 support matrix is:

- npm on supported Node.js releases for Linux, macOS, and Windows.
- Standalone executables for Linux x64/arm64, macOS x64/arm64, and Windows x64.
- An OCI container for the read-only MCP server on Linux x64/arm64.

The primary installation surface is npm. Standalone executables serve hosts
that do not manage Node.js, and the container serves isolated MCP deployments.

## v0.1 goals

1. Define and validate a versioned, machine-readable capability schema.
2. Load multiple local or remote registry sources with deterministic
   precedence and explain where each effective record came from.
3. Let users and agents list, search, inspect, and validate capabilities from
   the CLI.
4. Expose the effective catalog through a read-only MCP server.
5. Generate lightweight discovery adapters for supported agent platforms.
6. Add, remove, inspect, and synchronize registry sources without storing
   credentials in catalog data.
7. Publish reproducible npm, standalone executable, and container artifacts.
8. Prove the design with a private Driftward registry consumed by multiple
   agent environments.

## v0.1 non-goals

- Executing tools or acting as an agent runtime, workflow engine, or scheduler.
- Storing, brokering, refreshing, or synchronizing secrets and session tokens.
- Installing or updating the tools described by registry records.
- Hosting a public marketplace, hosted control plane, or graphical interface.
- Monitoring every registered service continuously.
- Replacing MCP, agent skills, shell completion, or native platform tool
  systems. Capykit indexes and generates adapters for them.
- Publishing Driftward's private registry or making private capabilities work
  outside their authorized environment.

## v0.1 success criteria

The release is successful when all of the following are demonstrated in CI or
the Driftward pilot:

1. The same fixture catalog produces identical effective output across two
   runs and across the CLI and MCP interfaces.
2. Schema errors, duplicate identifiers, invalid source references, and
   unavailable declared commands produce actionable validation or doctor
   output and a non-zero exit code where appropriate.
3. A user can install the npm package and run `capykit --help` on Linux, macOS,
   and Windows in the release matrix.
4. Published standalone executables run `capykit --help` on every documented
   target, and the container passes an MCP initialization smoke test.
5. At least three Driftward agent environments discover the same shared
   capability through the private registry without duplicating its metadata in
   platform-specific configuration.
6. Automated secret scanning finds no credentials, tokens, cookies, or private
   registry records in public release artifacts.
7. A clean host can follow the published documentation to install Capykit, add
   a registry source, find a capability, and inspect its invocation metadata.

## Consequences

- Schema, trust-boundary, and scaffold work can proceed independently against a
  stable product contract.
- Capykit remains useful outside Driftward while Driftward retains private
  operational metadata in a separate repository.
- The application describes invocation and availability but does not execute
  tools or own their credentials in v0.1.
- Supporting both Node.js and standalone distributions adds release work, but
  avoids making a managed Node.js runtime mandatory for every host.

## Rejected alternatives

### Host-only Driftward script

This would solve immediate discovery on one VPS but would preserve the current
platform fragmentation and prevent independent installation.

### Python

Python fits existing Driftward automation, but TypeScript better matches the
target npm distribution, JSON Schema tooling, and MCP ecosystem. Python remains
a valid language for tools described by Capykit.

### Go

Go would simplify standalone binaries, but it would make npm a wrapper and add
friction around the TypeScript-heavy agent integration ecosystem. Standalone
packaging will instead compile the TypeScript application into release
executables.

### Bundling the Driftward registry with the application

This would blur code and company-data ownership, increase publication risk,
and make public releases depend on private operational state.

### Credential broker or execution gateway

Those are separate security-sensitive products. Including them in v0.1 would
make a discovery registry responsible for secrets and command execution before
its metadata and trust model are proven.
