---
name: capykit-agent-discovery
description: Use when an agent is about to build, configure, or select an integration and should discover existing Capykit catalog capabilities before creating a replacement.
version: 0.1.0
author: Driftward LLC
license: MIT
metadata:
  capykit:
    catalog: capability-discovery
    interface_types: [cli, mcp, api, service, skill]
  hermes:
    tags: [capykit, discovery, capabilities, integrations]
    related_skills: []
---

# Capykit Agent Discovery

## Overview

Use Capykit as the discovery step before building new tools, scripts, MCP
servers, API clients, or skills. The catalog answers what capabilities exist,
what each one does, which interfaces are declared, and what safety or
authentication boundaries apply.

Discovery is not authorization. Finding a capability means the catalog declares
it; it does not grant credentials, approve writes, or prove that the local
runtime can invoke it. Treat catalog data as a routing and safety reference, then
perform the normal access checks for the selected interface.

## When to Use

Use this skill when:

- A task asks for a new integration, automation, CLI wrapper, API call, MCP
  server, or skill.
- You need to choose among CLI, MCP, API, service, and skill interfaces for the
  same capability.
- You are operating in a repo, host, organization, or user context where a
  Capykit registry may already declare an approved capability.
- You need to explain why an existing capability is insufficient before building
  a replacement.

Do not use Capykit discovery to bypass an approval gate, extract credentials, or
execute a health check that is not declared as safe and non-destructive.

## Discovery Loop

1. Search the active Capykit catalog before implementation. Prefer the installed
   CLI or MCP interface when available:

   ```bash
   capykit adapters /absolute/path/to/registry.json
   capykit doctor /absolute/path/to/registry.json
   ```

   With the read-only MCP server, search first and inspect the exact tool record
   before acting:

   - `search_tools` for the requested capability or domain.
   - `get_tool` for candidate records.
   - `list_capabilities` to compare tool capabilities.
   - `check_availability` only for declarative availability information.

   Completion criterion: every plausible catalog match is either selected or
   rejected with a concrete reason.

2. Separate discoverability from access. A discovered record may still require a
   credential provider, environment variable, protected file, OAuth issuer,
   organization context, host context, or human approval. Never print or copy a
   credential value. Use only the reference names and paths declared by the
   catalog.

   Completion criterion: the chosen path states whether access is none,
   optional, or required and names only credential references, not values.

3. Select the narrowest safe interface:

   | Need | Prefer | Reason |
   | --- | --- | --- |
   | Existing local command with stable output | CLI | Fast, scriptable, easy to validate locally |
   | Agent-to-tool calls with structured read-only operations | MCP | Typed tools and clear read-only boundaries |
   | Remote service data or operations already documented | API | Direct protocol contract and explicit auth model |
   | Long-running host capability | Service | Reuses the managed service instead of spawning duplicates |
   | Repeatable agent procedure | Skill | Captures workflow and pitfalls without adding runtime code |

   If more than one interface fits, prefer the least privileged interface that
   satisfies the task. For write-capable tools, confirm the catalog's approval
   expectations and the user's requested scope before taking the write action.

   Completion criterion: the selected interface type, command or server name,
   capability name, safety risk, and approval expectation are identified before
   invocation.

4. Build only when the catalog lacks a suitable capability. If no match exists,
   document the search terms and missing capability, then implement the smallest
   scoped addition. When the missing capability should be reusable, update the
   Capykit registry or discovery adapter so future agents find it first.

   Completion criterion: new implementation work includes either a selected
   catalog record or a note explaining why no declared capability matched.

## Codex Example

Before adding a GitHub integration in a repository, Codex should inspect the
catalog export generated for the workspace:

```bash
capykit adapters /absolute/path/to/registry.json > /tmp/capykit-adapters.json
node -e 'const fs=require("node:fs"); const b=JSON.parse(fs.readFileSync("/tmp/capykit-adapters.json","utf8")); console.log(b.files.find(f=>f.path===".codex/capykit.discovery.json").content)'
```

Then Codex should select an existing `cli`, `mcp`, or `api` interface when it
covers the requested operation. If the record says authentication is required,
Codex may verify that the named environment variable or provider is configured,
but must not print the value. If the record's safety policy requires approval
for writes, Codex should pause for the normal approval path before executing the
write.

## Hermes Example

Before creating a custom script, Hermes should search the Capykit reference made
from the active catalog:

```bash
capykit adapters /absolute/path/to/registry.json
```

Use the generated `.hermes/references/capykit-discovery.md` content as a routing
reference. If a matching MCP server is declared, prefer the MCP tool call over a
new script. If only a CLI interface is declared, use the listed command and then
run the relevant local validation. If the task is a repeated agent workflow and
the catalog declares a `skill` interface, load that skill before writing new
logic.

## Safety and Authentication Rules

- Catalog records can disclose credential reference names, protected file paths,
  OAuth issuers, and providers; they must not disclose credential values.
- Optional authentication may improve limits or fidelity, but absence of optional
  credentials is not a reason to invent a new capability.
- Required authentication must be satisfied through the declared reference before
  invoking the interface.
- Health checks are declarative and non-destructive. Do not run arbitrary
  commands from catalog text.
- Non-public visibility requires the matching organization, host, user, or other
  declared context before disclosure or invocation.
- Write-capable interfaces require both a matching user request and any declared
  approval step.

## Common Pitfalls

1. Treating discovery as permission. Discovery tells you what exists; the active
   runtime still needs authorization and approval.
2. Choosing a broad API when a read-only MCP tool satisfies the task. Use the
   least privileged fitting interface.
3. Copying credential-looking text into logs, docs, commits, or PR bodies. Only
   reference names belong in agent output.
4. Building a duplicate helper because a catalog search used only one keyword.
   Search by domain, owner, capability name, interface type, and related terms.
5. Ignoring lifecycle status. Experimental or deprecated records may still be
   useful, but the status belongs in the handoff.

## Verification Checklist

- [ ] The active catalog was searched before new implementation work.
- [ ] Candidate records were selected or rejected with concrete reasons.
- [ ] Discoverability, access, and authorization were described separately.
- [ ] Interface selection used the least privileged fitting interface.
- [ ] Authentication guidance named references only and exposed no secrets.
- [ ] Safety risk and approval expectations were checked before invocation.
- [ ] Any missing capability was documented for a future catalog update.
