# Driftward private capability registry source

This document defines the private Driftward capability registry source for Capykit-compatible operators. The schema-valid seed file is `docs/driftward-private-capability-registry.registry.json`.

The source is intentionally separate from the public application runtime: Capykit treats it as an operator-approved registry document to be stored in a private repository or host-local protected path before activation. The public app continues to ship schemas, loaders, CLI commands, documentation, and public fixtures only.

## Seeded capabilities

The seed registry records these pilot capabilities: personal-hermes, driftward-hermes, driftward-hermes-smoke, Browserbase/browse, agent-browser, Linear, Himalaya, GitHub CLI, and Notion API.

Each record includes:

- an owner declaration for Driftward operations;
- a scope using personal, host, or organization visibility plus context IDs;
- credential references that name environment variables, protected files, or providers without storing credential values;
- documentation links;
- a declarative health check constrained to the approved v0.1 health-check kinds;
- safety and approval metadata suitable for discovery by agents.

## Activation pattern

Store the registry JSON in the private source of truth, then register it with `capykit sources` as an operator-approved source. Example local-file activation:

```bash
capykit sources add --config /etc/capykit/registry-sources.json \
  --id driftward.private --layer organization \
  --file-root /srv/driftward-capabilities \
  --file-path driftward-private-capability-registry.registry.json
```

A Git-backed source can be used instead when the private repository and resolved revision are available. Do not commit credential values or runtime session material to the source repository; only references belong in registry records.

## Validation

The seed registry is included in `npm run check:schema`, which validates it against the canonical v0.1 JSON Schema. The public repository safety check also scans tracked files for credential-shaped material.
