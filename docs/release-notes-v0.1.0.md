# Capykit v0.1.0 release notes

Capykit v0.1.0 is the first public package release for the portable capability
registry. It packages the same validated TypeScript application for npm,
standalone executable artifacts, and the GHCR container image.

## Highlights

- Publishes `@driftward/capykit` with the `capykit` and `capykit-mcp`
  binaries for Node.js 22 and newer.
- Provides the v0.1 registry schema, public fixtures, registry loading,
  registry doctor, discovery adapter, and read-only MCP server contracts.
- Documents npm installation, standalone artifact installation, container image
  usage, and schema authoring workflows.
- Keeps Driftward-only registry records, credentials, and private runtime state
  outside the public package, fixtures, generated adapters, standalone
  artifacts, container inputs, and release notes.

## Validation before publishing

Run the public release gate on the release commit before tagging:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
npm run check:schema
npm run check:secrets
npm publish --dry-run --access public --provenance
npm audit --audit-level=moderate
```

The `v0.1.0` tag and GitHub release should be created only after the release
commit passes the validation gate.
