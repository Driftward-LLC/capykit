import { createHash } from "node:crypto";
import type { RegistryCatalog, ResolvedRegistryTool, RegistryTool } from "./registry.js";

export type DiscoveryAdapterPlatform = "codex" | "hermes";

export interface DiscoveryAdapterAuthReference {
  readonly kind: string;
  readonly name?: string;
  readonly path?: string;
  readonly issuer?: string;
}

export interface DiscoveryAdapterAuthRequirement {
  readonly id: string;
  readonly type: string;
  readonly references: readonly DiscoveryAdapterAuthReference[];
}

export interface DiscoveryAdapterInterfaceCapability {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
}

export interface DiscoveryAdapterInterface {
  readonly id: string;
  readonly type: string;
  readonly command?: string;
  readonly serverName?: string;
  readonly transport?: string;
  readonly capabilities: readonly DiscoveryAdapterInterfaceCapability[];
}

export interface DiscoveryAdapterTool {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly visibility: string;
  readonly audiences: readonly string[];
  readonly platforms: readonly string[];
  readonly authentication: {
    readonly mode: string;
    readonly requirements: readonly DiscoveryAdapterAuthRequirement[];
  };
  readonly interfaces: readonly DiscoveryAdapterInterface[];
  readonly source: {
    readonly layer: string;
    readonly registryId: string;
    readonly sha256: string;
  };
}

export interface DiscoveryAdapterFile {
  readonly path: string;
  readonly content: string;
}

export interface DiscoveryAdapterBundle {
  readonly format: "capykit.discoveryAdapters.v0.1";
  readonly catalogDigest: string;
  readonly generatedFrom: {
    readonly toolCount: number;
    readonly sourceCount: number;
  };
  readonly files: readonly DiscoveryAdapterFile[];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).sort((left, right) => left.localeCompare(right, "en-US"));
}

function objectArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en-US")).map(([key, entry]) => [key, sortJson(entry)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function authenticationRequirements(tool: RegistryTool): readonly DiscoveryAdapterAuthRequirement[] {
  const authentication = typeof tool.authentication === "object" && tool.authentication !== null && !Array.isArray(tool.authentication) ? tool.authentication as Record<string, unknown> : {};
  return objectArray(authentication.requirements).map((requirement) => ({
    id: stringField(requirement.id) ?? "unknown",
    type: stringField(requirement.type) ?? "unknown",
    references: objectArray(requirement.references).map((reference) => {
      const name = stringField(reference.name);
      const path = stringField(reference.path);
      const issuer = stringField(reference.issuer);
      return {
        kind: stringField(reference.kind) ?? "unknown",
        ...(name === undefined ? {} : { name }),
        ...(path === undefined ? {} : { path }),
        ...(issuer === undefined ? {} : { issuer }),
      };
    }).sort((left, right) => `${left.kind}:${left.name ?? left.path ?? left.issuer ?? ""}`.localeCompare(`${right.kind}:${right.name ?? right.path ?? right.issuer ?? ""}`, "en-US")),
  })).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function adapterInterfaces(tool: RegistryTool): readonly DiscoveryAdapterInterface[] {
  return objectArray(tool.interfaces).map((iface) => {
    const command = stringField(iface.command);
    const serverName = stringField(iface.serverName);
    const transport = stringField(iface.transport);
    return {
      id: stringField(iface.id) ?? "unknown",
      type: stringField(iface.type) ?? "unknown",
      ...(command === undefined ? {} : { command }),
      ...(serverName === undefined ? {} : { serverName }),
      ...(transport === undefined ? {} : { transport }),
      capabilities: objectArray(iface.capabilities).map((capability) => {
        const usage = stringField(capability.usage);
        return {
          name: stringField(capability.name) ?? "unknown",
          summary: stringField(capability.summary) ?? "No summary declared.",
          ...(usage === undefined ? {} : { usage }),
        };
      }).sort((left, right) => left.name.localeCompare(right.name, "en-US")),
    };
  }).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function adapterTool(tool: ResolvedRegistryTool): DiscoveryAdapterTool {
  const scope = typeof tool.record.scope === "object" && tool.record.scope !== null && !Array.isArray(tool.record.scope) ? tool.record.scope as Record<string, unknown> : {};
  const authentication = typeof tool.record.authentication === "object" && tool.record.authentication !== null && !Array.isArray(tool.record.authentication) ? tool.record.authentication as Record<string, unknown> : {};
  return {
    id: tool.id,
    name: stringField(tool.record.name) ?? tool.id,
    summary: stringField(tool.record.summary) ?? "No summary declared.",
    visibility: stringField(scope.visibility) ?? "unknown",
    audiences: stringArray(scope.audiences),
    platforms: stringArray(scope.platforms),
    authentication: {
      mode: stringField(authentication.mode) ?? "unknown",
      requirements: authenticationRequirements(tool.record),
    },
    interfaces: adapterInterfaces(tool.record),
    source: {
      layer: tool.provenance.layer,
      registryId: tool.provenance.registryId,
      sha256: tool.provenance.sha256,
    },
  };
}

export function discoveryAdapterTools(catalog: RegistryCatalog): readonly DiscoveryAdapterTool[] {
  return catalog.tools.map(adapterTool).sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

function renderAgentsGuidance(tools: readonly DiscoveryAdapterTool[], catalogDigest: string): string {
  const lines = [
    "# AGENTS.md",
    "",
    "This file is generated from the Capykit catalog. Do not edit it by hand; regenerate it from catalog metadata.",
    `Catalog digest: ${catalogDigest}`,
    "",
    "Before implementation:",
    "- Discover approved capabilities in the Capykit catalog before adding new tools or integrations.",
    "- Prefer declared interfaces and documentation over ad hoc commands.",
    "- Treat credential references as boundaries: use only the referenced provider, environment variable, or file path; never copy or print credential values.",
    "- If a needed capability is missing, update the catalog first so adapters stay reproducible.",
    "",
    "Available agent-facing tools:",
  ];
  for (const tool of tools.filter((entry) => entry.audiences.includes("agent"))) {
    lines.push(`- ${tool.id}: ${tool.summary} (${tool.visibility}; ${tool.interfaces.map((entry) => entry.type).join(", ")})`);
  }
  return `${lines.join("\n")}\n`;
}

function codexConfig(tools: readonly DiscoveryAdapterTool[], catalogDigest: string): string {
  return stableJson({
    format: "capykit.codexDiscovery.v0.1",
    catalogDigest,
    instructions: [
      "Inspect Capykit discovery data before implementing new integration logic.",
      "Use authentication references only as boundaries; never expose credential values.",
    ],
    tools: tools.filter((tool) => tool.audiences.includes("agent")),
  });
}

function hermesReference(tools: readonly DiscoveryAdapterTool[], catalogDigest: string): string {
  const lines = [
    "# Capykit discovery reference",
    "",
    "Generated from Capykit catalog metadata.",
    `Catalog digest: ${catalogDigest}`,
    "",
    "Use this reference to choose declared capabilities before creating custom scripts, plugins, or MCP integrations.",
    "Credential entries below are references only; they are not credential values.",
    "",
  ];
  for (const tool of tools.filter((entry) => entry.audiences.includes("agent"))) {
    lines.push(`## ${tool.name}`);
    lines.push(`- id: ${tool.id}`);
    lines.push(`- summary: ${tool.summary}`);
    lines.push(`- visibility: ${tool.visibility}`);
    lines.push(`- interfaces: ${tool.interfaces.map((entry) => `${entry.id} (${entry.type})`).join(", ")}`);
    lines.push(`- auth: ${tool.authentication.mode}${tool.authentication.requirements.length === 0 ? "" : ` via ${tool.authentication.requirements.map((entry) => entry.references.map((reference) => reference.name ?? reference.path ?? reference.issuer ?? reference.kind).join("/")).join(", ")}`}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function generateDiscoveryAdapterBundle(catalog: RegistryCatalog): DiscoveryAdapterBundle {
  const tools = discoveryAdapterTools(catalog);
  const catalogDigest = digest({ sources: catalog.sources.map(({ layer, registryId, sha256, sourceId }) => ({ layer, registryId, sha256, sourceId })), tools });
  return {
    format: "capykit.discoveryAdapters.v0.1",
    catalogDigest,
    generatedFrom: { toolCount: tools.length, sourceCount: catalog.sources.length },
    files: [
      { path: "AGENTS.md", content: renderAgentsGuidance(tools, catalogDigest) },
      { path: ".codex/capykit.discovery.json", content: codexConfig(tools, catalogDigest) },
      { path: ".hermes/references/capykit-discovery.md", content: hermesReference(tools, catalogDigest) },
    ],
  };
}
