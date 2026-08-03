# ADR 0002: Registry trust and execution boundaries

- Status: Accepted
- Date: 2026-08-03
- Decision owner: Driftward LLC
- Linear issue: [ENG-4](https://linear.app/driftward/issue/ENG-4/define-registry-trust-credential-and-execution-boundaries)
- Depends on: [ADR 0001](0001-product-contract.md)

## Context

Capykit combines capability metadata from bundled, local, and remote registry
sources. The catalog is consumed by people and agents, so a malicious record
could otherwise become an instruction-injection vector, expose credential
locations, trigger server-side requests, or turn a health check into arbitrary
code execution.

Capykit v0.1 is a discovery product. It does not broker credentials, execute
registered tools, or provide a generic automation surface. This decision makes
that boundary enforceable and defines the contract that source loading,
validation, doctor checks, and MCP delivery must implement.

The machine-readable policy is
[`policies/v0.1/security-policy.json`](../../policies/v0.1/security-policy.json).
Normative statements in this ADR use **MUST**, **MUST NOT**, and **SHOULD** as
described by RFC 2119.

## Trust model

Every source MUST have exactly one trust tier. Trust applies to the source and
its provenance, not to claims made inside a registry document.

<!-- markdownlint-disable MD013 -->

| Tier | Entry condition | Activation | Updates |
| --- | --- | --- | --- |
| `operator-approved` | A local operator explicitly adds the source through trusted configuration | Active only after successful validation | Manual in v0.1 |
| `bundled` | Shipped in a verified Capykit release artifact | Active with that release | Only through a package or binary release |
| `untrusted` | Discovered, imported, or supplied without explicit approval | Quarantined and inspect-only | Never synchronized or activated |

<!-- markdownlint-enable MD013 -->

An operator-approved source has the highest precedence because it represents an
explicit local policy decision. Bundled records follow. Untrusted records MUST
NOT enter the effective catalog or override any active record. Within one tier,
the loader uses explicit source priority and then stable source ID as the final
tie-breaker. It MUST explain the winning source for every effective record.

Moving a source from `untrusted` to `operator-approved` is a deliberate
configuration mutation. Registry content cannot promote itself. A source also
cannot change its own trust tier, precedence, origin, update mode, or approval
state.

## Provenance and updates

Every loaded source MUST retain these provenance fields outside the authored
registry document:

- stable source ID;
- canonical source URI;
- assigned trust tier;
- immutable revision when the transport supplies one;
- SHA-256 digest of the exact bytes validated; and
- fetch or read timestamp.

The effective catalog MUST retain the winning source ID, revision, and digest
for each record. Logs and MCP responses MAY expose those identifiers but MUST
NOT copy credentials, authorization headers, or private source contents.

Remote synchronization is manual in v0.1. A sync MUST fetch into a temporary
location, enforce the URL rules below, limit redirects to three same-origin
hops, validate schema and semantics, run secret detection, compute provenance,
and only then atomically replace the cached source. A failed update MUST leave
the last known-good source active and return a nonzero result. Validation and
activation MUST use the same bytes identified by the recorded digest.

## Credential boundary

Registry records may name an environment variable, protected file path,
external provider, or OAuth issuer. These are references for an authorized
caller; they are not credential values.

Capykit MUST NOT read, resolve, refresh, test, copy, log, return, or transmit a
referenced credential during registry ingestion, list, search, inspect,
validation, doctor, adapter generation, or MCP operations. In particular, a
`file` authentication reference is not permission to open that file.

Registry documents, extensions, examples, errors, caches, and generated
adapters MUST reject or redact:

- credential-like keys such as token, secret, password, cookie,
  authorization, API key, client secret, or private key;
- authorization header values;
- private-key blocks;
- recognized access-token prefixes; and
- complete webhook URLs whose path contains a bearer secret.

Secret detection is defense in depth, not proof that content is public. A
positive result blocks activation and identifies only the field path and
detector category. It MUST NOT repeat the matched value. Unknown high-entropy
strings remain a residual risk and SHOULD be covered by release secret
scanning and private-registry access controls.

## Path and URL handling

### Registry paths

The loader MUST resolve a relative source against its configured registry root,
canonicalize the result before opening it, and verify that the canonical path
remains under an explicitly allowed root. It MUST reject null bytes, parent
traversal segments, symlink escapes, and anything other than a regular file.
Validation MUST be repeated when opening the file to reduce check/use races.

Interface locations and authentication references are metadata. They do not
inherit permission from the registry-source allowlist and MUST NOT be opened by
discovery or MCP operations.

### Remote registry URLs

Remote sources and `http-get` health checks MUST use HTTPS. URLs MUST NOT
contain user information or fragments. Before every connection, including
redirects, the client MUST resolve all candidate addresses and reject loopback,
link-local, private, multicast, unspecified, and cloud-metadata destinations.
Redirects MUST remain on the original origin and use the same validation.

The client MUST use bounded connect/read timeouts, response-size limits, and no
ambient proxy or credential configuration unless an operator-approved future
policy explicitly adds it. DNS rebinding and proxy behavior are implementation
risks that tests MUST exercise before remote synchronization ships.

## Health-check execution

Registry health checks are declarations. A consumer MAY decline to run any of
them. A consumer that runs checks MUST use the allowlist below and MUST enforce
a five-second timeout, bounded output, no inherited stdin, and no credential
injection.

<!-- markdownlint-disable MD013 -->

| Kind | Permitted operation | Explicitly forbidden |
| --- | --- | --- |
| `command-available` | Look up one executable name on the consumer's approved `PATH` | Shells, arguments, scripts, executable paths, environment or working-directory changes |
| `http-get` | Unauthenticated HTTPS GET with status and size limits | Headers, bodies, non-GET methods, private networks, cross-origin redirects |
| `mcp-initialize` | Initialize the declared MCP interface and close it | Tool invocation, resource reads, sampling, elicitation, or credential discovery |
| `service-active` | Query declared service-manager status | Start, stop, restart, enable, logs, `sudo`, or manager mutation |
| `file-readable` | Check metadata and effective read permission for an absolute declared path | Reading content, following an out-of-policy path, or checking an authentication-reference file |

<!-- markdownlint-enable MD013 -->

Unknown health-check kinds and unknown fields fail closed. Consumers MUST NOT
translate declarative checks into a shell command. `command-available` accepts
only a single executable token matching the policy's allowlist expression.

## Read-only MCP contract

The Capykit MCP server exposes only:

- `list_capabilities`;
- `search_capabilities`;
- `get_capability`;
- `list_sources`;
- `get_source`; and
- `validate_registry`.

These tools may read the already effective catalog or validate supplied
registry data without activating or persisting it. MCP MUST NOT expose source
add/remove/sync, adapter writes, package installation, health-check execution,
registered-tool invocation, shell access, generic HTTP requests, filesystem
reads, or generic remote execution.

MCP responses apply caller scope before returning records. Private records and
credential-reference metadata MUST NOT cross an authorization boundary merely
because the server can read the underlying registry.

## Threat model

<!-- markdownlint-disable MD013 -->

| Threat | Boundary and control | Residual risk |
| --- | --- | --- |
| Malicious or compromised remote registry | Explicit trust tier, HTTPS, origin-safe redirects, digest provenance, validation before atomic activation | A trusted publisher can still publish harmful instructions |
| Registry record overrides a safer tool | Trust-aware precedence and per-record provenance | An operator can intentionally approve a bad override |
| Path traversal or symlink escape | Configured roots, canonicalization, regular-file requirement, repeated open-time check | Host filesystem compromise can invalidate assumptions |
| SSRF and cloud metadata access | HTTPS-only public destinations, address validation on every connection and redirect | DNS or proxy implementation defects |
| Credential committed in metadata | Schema exclusion, key/value detectors, redacted errors, release secret scanning | Novel formats and high-entropy values may evade detectors |
| Credential reference is dereferenced | Application-level prohibition across all discovery and MCP paths | A future feature could regress without boundary tests |
| Health check executes arbitrary code | Closed kind allowlist, field allowlists, no shell/arguments, bounded runtime | The located executable or service manager may itself be compromised |
| MCP client invokes mutation or execution | Fixed read-only tool names and no generic transport/filesystem tools | Denial of service through expensive read queries |
| Prompt injection in descriptions | Registry text is untrusted data, never agent instruction; adapters preserve data/instruction separation | Downstream agents may ignore that separation |
| Stale or rolled-back source | Revisions, digests, timestamps, last-known-good state, explicit manual update | Manual operators may accept an old but valid source |

<!-- markdownlint-enable MD013 -->

## Verification contract

[`examples/security-policy-cases.json`](../../examples/security-policy-cases.json)
contains positive and negative cases for paths, URLs, secret detection, health
checks, and MCP tools. `node scripts/test-security-policy.mjs` executes those
cases and checks the frozen trust decisions.

Future loader, doctor, and MCP implementations MUST reuse these cases or prove
equivalent coverage. ENG-8 implements validation and doctor behavior; ENG-12
implements source mutation and synchronization. Neither issue may weaken this
policy without a new ADR and versioned policy change.

## Consequences

- Private registries can describe where authorized callers obtain credentials,
  but Capykit never becomes a secret broker.
- Registry health is useful but intentionally less expressive than arbitrary
  command probes.
- Remote source support requires careful network controls before it can ship.
- The MCP server remains broadly deployable because it cannot mutate sources or
  execute the tools it describes.
- Some convenient checks and integrations must live in a separate trusted
  automation runtime rather than in Capykit.
