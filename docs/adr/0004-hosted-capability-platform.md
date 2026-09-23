# ADR 0004: Hosted connections and functions for people and agents

- Status: Accepted product direction; hosted implementation pending
- Date: 2026-09-21
- Basis: The user's clarification that connections, functions, and capabilities
  are hosted in Capykit and provisioned as needed for users or agents, using
  Maton as the reference product
- Amends: [ADR 0001](0001-product-contract.md) product scope and
  [ADR 0002](0002-registry-trust-boundaries.md) future hosted-service boundary
- Repositions: [ADR 0003](0003-environment-profiles.md) as optional local setup
- Linear delivery plan: [Hosted Capykit product brief](https://linear.app/driftward/document/hosted-capykit-product-brief-and-first-delivery-milestone-9f21ba91831d)
- Implementation baseline: [Hosted Capykit MVP specification](https://linear.app/driftward/document/hosted-capykit-mvp-specification-github-connections-and-shared-50077758a4d6)

Linear tracks the hosted milestone in ENG-121 through ENG-126, including
acceptance criteria and dependency links. ENG-127 tracks review and integration
of the existing local discovery/profile changes. Update delivery status and
implementation decisions there; this ADR records product direction.

The linked implementation specification scopes the first invite-only workspace
and GitHub issue-review flow, including selected infrastructure, connection and
permission contracts, stored artifacts, execution limits, and completion checks.
It resolves the open implementation choices described below without asserting
that the hosted backend has been built or provisioned.

## Staging infrastructure decision

On 2026-09-23, the operator selected the existing VPS for inexpensive web testing.
Use one portable Docker Compose deployment with ordinary PostgreSQL and a
self-hosted authentication service. Railway and managed Supabase are no longer
staging prerequisites. The application image and service topology remain the
same when moved to another Docker host; configuration, ingress, and persisted
data move with it. See the [deployment guide](../hosted-workspace-foundation.md).

## Product contract

Capykit is being built as a hosted capability platform. A workspace stores its
connections, versioned functions, tools, skills, and access rules centrally.
People use the web app; agents and other programs use the API, MCP, or CLI.
Every client reaches the same backend and the same authorized capabilities.

Connect an account once within its workspace, publish a capability once, and
make it usable from authorized environments. A new client authenticates to
Capykit and receives its permitted catalog. Provider account credentials stay
with the hosted connection service. A different workspace or account still
requires its own connection and consent.

The registry and portable profiles already implemented are useful components.
They do not satisfy the hosted product by themselves. Local package installation
is optional for capabilities that actually need to run in a client environment.

## Reference product and Capykit decisions

Maton describes managed app accounts and credential refresh in
[Connections](https://docs.maton.ai/connections), authenticated forwarding in
[Gateway](https://docs.maton.ai/gateway), versioned code running in isolated
environments in [Functions](https://docs.maton.ai/functions), and execution
records in [Managing runs](https://docs.maton.ai/functions/runs). Those are the
reference product primitives relevant to this direction.

Maton's [multi-tenancy guide](https://docs.maton.ai/connections/multi-tenancy)
describes an application-maintained mapping from users to connection IDs.
Capykit's design below adds explicit workspace ownership and grants for human
and agent identities. These are Capykit decisions, not claims about Maton's
internal implementation or permission model. Maton is a reference; no dependency
on its service has been selected.

## Hosted objects

<!-- markdownlint-disable MD013 -->

| Object | Responsibility |
| --- | --- |
| Workspace and principal | Own resources and identify a human or an agent. Agents act through explicit grants or delegated authority. |
| Connection | Represent an authorized provider account, scopes, health, and reconnect/revoke lifecycle. Protected credentials are stored separately from catalog metadata. |
| Capability | Describe an available tool, skill, or function, including its input/output contract, version, connection requirements, and allowed operations. |
| Function version or skill artifact | Persist code or complete skill files centrally. Functions execute in a provisioned runtime; skills are retrieved by authorized clients or loaded into a hosted agent run. |
| Grant | Bind a principal to permitted capabilities and connections, with any approval requirements and usage limits. |
| Run | Record who invoked which version using which connection, plus status, permitted outputs, redacted logs, and measured usage. |

<!-- markdownlint-enable MD013 -->

Descriptions, visibility labels, and registry context strings are metadata.
Authorization comes from authenticated identity and stored grants. In
particular, the current local MCP server's caller-supplied visibility/context
filters must not become the hosted service's tenant authorization mechanism.

## Provisioning and invocation

1. The caller authenticates to Capykit and requests a capability with inputs.
2. The backend verifies the workspace, grant, connection, input contract,
   required approval, and applicable usage limit.
3. An authorized provider request uses the connection gateway. A function run
   starts or acquires an isolated runtime with the selected code version and
   only its permitted connection access. A skill request returns its authorized
   artifact; retrieving a skill and executing a function are distinct operations.
4. Capykit returns the result or run ID, persists the run outcome and usage,
   and releases execution resources when the run finishes.

The browser and agent use the same invocation contract. Neither receives a
provider credential merely by discovering or invoking a capability. The server
must not fall back to another user's account when a connection is absent or
unauthorized. Revocation must affect subsequent requests.

## Implementation direction

Start with one application backend, a durable database, protected connection
storage, and an established isolated execution service. Use the same backend
for the web app and agent-facing endpoints. Select the concrete infrastructure
when implementing the first flow; this decision does not select a vendor,
deployment target, billing model, or a custom sandbox implementation.

The first rollout may serve one workspace while retaining explicit workspace
and principal ownership. Public customer signup can follow. That rollout order
is a working assumption, not a restriction on the product's eventual audience.

The first complete hosted milestone is:

1. A user signs in and connects one provider account in the app.
2. A complete skill and one versioned function are stored centrally. The
   function performs one useful read through that connection.
3. The user runs it from the web app and an authorized agent runs the same
   function from another environment through Capykit, without local provider
   credentials or a local copy of the function implementation.
4. Both invocations appear in shared run history with the correct actor,
   function version, selected connection, result, and usage.
5. A second principal without the grant cannot discover private artifacts or
   invoke the function. Revoking access blocks the next call; restarting the
   application preserves stored connections, artifacts, and run history.

This milestone must use a real provider connection and isolated hosted
execution before being called complete. Local mocks can support development
but are not evidence that the hosted product works. One integration is enough
to prove the flow. More providers, event triggers, schedules, and customer
billing build on it after it is demonstrated.

## Relationship to the current implementation

The current checkout implements catalog validation, provenance, search/detail,
CLI discovery, read-only local MCP, adapter exports, and portable local profiles.
It has no hosted application API, user authentication, connection broker,
durable application database, function executor, web console, or usage ledger.

ADR 0001's exclusions of hosting, graphical interfaces, credential brokering,
and execution no longer define the whole product. They still describe the
existing discovery package. ADR 0002's prohibitions on secrets in registries,
public artifacts, and discovery output continue to apply. The hosted connection
service is a new, explicit credential boundary, separate from that metadata.

Hosted invocation requires a versioned API and policy with authenticated grants.
It must be added deliberately; changing a local MCP tool name or disabling the
existing secret detector does not establish that boundary. Existing v0.1 policy
tests continue to protect the discovery package while hosted behavior is built.
