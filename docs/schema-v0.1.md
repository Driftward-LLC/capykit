# Capykit schema v0.1

The canonical v0.1 schema is
[`schemas/v0.1/registry.schema.json`](../schemas/v0.1/registry.schema.json).
It uses JSON Schema 2020-12 and identifies registry documents with the explicit
`schemaVersion` value `0.1.0`.

## Document model

A registry document contains its identity and a list of tool records. Every
tool has stable identity, purpose, owners, one or more interfaces, scope,
authentication requirements, safety and lifecycle declarations, health checks,
documentation, relationships, and examples.

Supported interface types are:

- `cli`
- `mcp`
- `api`
- `service`
- `skill`

Every tool record requires these fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable merge and relationship key |
| `name`, `summary` | Human and agent discovery text |
| `owners` | Responsible people, teams, or projects |
| `interfaces` | Typed invocation and capability declarations |
| `scope` | Visibility, audience, and supported platforms |
| `authentication` | Requirements and secret references without values |
| `safety` | Risk and approval expectations |
| `lifecycle` | Current support state and replacement metadata |
| `healthChecks` | Safe declarative availability checks, or an empty list |
| `documentation` | At least one authoritative reference |
| `relationships` | Cross-tool relationships, or an empty list |
| `examples` | Interface-linked usage examples, or an empty list |

`description` and namespaced `extensions` are optional. Interface variants
have their own required invocation fields in the canonical schema.

Non-public scope declarations also require one or more `contexts` identifying
the organizations, teams, users, or hosts to which the record applies.

Tool and interface IDs are stable merge keys. Changing an ID creates a new
record rather than renaming an existing record. Loaders must reject duplicate
tool IDs and duplicate interface IDs within a tool.

Source URI, priority, checksum, fetch time, and effective-record provenance are
loader metadata rather than authored tool fields. Loaders attach that metadata
after reading one or more registry sources so it cannot be confused with the
tool owner's declarations.

## Credential boundary

Registry records describe authentication requirements but never contain
credential values. An authentication reference can name:

- An environment variable.
- A protected file location.
- An external credential provider.
- An OAuth issuer.

Properties such as tokens, passwords, cookies, API-key values, authorization
headers, and session material are not part of the schema. Extensions do not
relax this rule.

Authentication `mode` distinguishes tools with no authentication from tools
where authentication is optional or required. Optional and required modes must
declare at least one reference; `none` must not declare any.

## Safe health checks

Health checks are declarative and limited to these non-destructive kinds:

- `command-available`
- `http-get`
- `mcp-initialize`
- `service-active`
- `file-readable`

Arbitrary commands, command arguments, request bodies, mutating HTTP methods,
and scripts are intentionally unsupported. Consumers may apply a stricter
allowlist before running any declared check.

## Relationships and references

JSON Schema validates the shape of references. Semantic validation must also
enforce:

- Tool IDs are unique within one registry document.
- Interface IDs are unique within each tool.
- Every relationship target names a tool in the same effective catalog.
- Every example `interfaceId` names an interface on its tool.
- `mcp-initialize` points to an MCP interface.
- `service-active` points to a service interface.
- Lifecycle replacements name another tool in the effective catalog.

Registry loaders will apply the same checks after combining sources, which
allows a relationship to resolve to a tool supplied by another source.

## Extensions

Optional extension keys must use a lowercase `x-*` namespace, for example
`x-openai-visibility`. v0.1 extension values are limited to JSON scalar values.
Unknown unnamespaced properties are rejected.

Extensions are advisory. They cannot override core identity, authentication,
safety, lifecycle, or invocation behavior, and they must not contain secrets.

## Versioning

The schema follows semantic versioning independently from the Capykit package:

- Patch versions clarify constraints without changing valid document meaning.
- Minor versions add backward-compatible optional vocabulary.
- Major versions, including a pre-1.0 minor increment, may introduce breaking
  document changes and require an explicit migration.

Consumers must reject unsupported schema versions instead of guessing. A
registry document remains on its declared version until it is intentionally
migrated.
