export * from "./registry.js";
export * from "./adapters.js";
export * from "./sources.js";
export * from "./host-discovery.js";
export * from "./profile-schema.js";
export * from "./profiles.js";

export const CAPYKIT_VERSION = "0.1.1";
export interface CapabilitySummary { readonly id: string; readonly name: string; readonly description: string; }
export function normalizeQuery(query: string): string { return query.trim().toLocaleLowerCase("en-US"); }
export function searchCapabilities(capabilities: readonly CapabilitySummary[], query: string): CapabilitySummary[] {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [...capabilities];
  return capabilities.filter((capability) => [capability.id, capability.name, capability.description].some((value) => normalizeQuery(value).includes(normalized)));
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

/** Project each interface's declared actions, including API operations. */
export function toolCapabilities(tool: RegistryTool): Record<string, unknown>[] {
  return records(tool.interfaces).flatMap((iface) => [
    ...records(iface.capabilities),
    ...records(iface.operations).map((operation) => ({
      ...operation,
      name: operation.id,
      usage: `${String(operation.method)} ${String(iface.baseUrl).replace(/\/+$/u, "")}${String(operation.path)}`,
    })),
  ].map((capability) => ({ ...capability, toolId: tool.id, interfaceId: iface.id, interfaceType: iface.type })));
}

/** Match all whitespace-separated keywords in any order; preserve catalog order. */
export function searchRegistryTools(tools: readonly ResolvedRegistryTool[], query: string): ResolvedRegistryTool[] {
  const terms = normalizeQuery(query).split(/\s+/u).filter(Boolean);
  return tools.filter(({ record }) => {
    const haystack = [record.id, record.name, record.summary,
      ...records(record.interfaces).flatMap((iface) => [iface.id, iface.type, iface.command, iface.serverName, iface.serviceName, iface.location]),
      ...toolCapabilities(record).flatMap((capability) => [capability.name, capability.summary, capability.usage]),
      ...records(record.examples).flatMap((example) => [example.title, example.usage]),
    ].filter((value): value is string => typeof value === "string").map(normalizeQuery).join("\n");
    return terms.every((term) => haystack.includes(term));
  });
}
import type { RegistryTool, ResolvedRegistryTool } from "./registry.js";
