# Capykit

Capykit is an installable capability registry for people and agents. It gives
every supported agent the same machine-readable answer to three questions:

- What tools are available?
- What can each tool do?
- How should the tool be invoked safely?

Capykit will ship as the `capykit` CLI, the `@driftward/capykit` npm package,
standalone executables, and the `ghcr.io/driftward-llc/capykit` container image.
The CLI and a read-only MCP server will expose the same layered capability
catalog.

The public application contains no Driftward credentials or private capability
records. Driftward-specific catalog data will live in a separate private
registry repository and will be consumed by Capykit at runtime.

## Project status

Capykit is in initial development. The accepted product contract, v0.1 scope,
and ownership boundaries are recorded in
[`docs/adr/0001-product-contract.md`](docs/adr/0001-product-contract.md).

Canonical planning lives in the
[Capykit Linear project](https://linear.app/driftward/project/capykit-72e4a9e54d52).
