export * from "./registry.js";

export const CAPYKIT_VERSION = "0.0.0";
export interface CapabilitySummary { readonly id: string; readonly name: string; readonly description: string; }
export function normalizeQuery(query: string): string { return query.trim().toLocaleLowerCase("en-US"); }
export function searchCapabilities(capabilities: readonly CapabilitySummary[], query: string): CapabilitySummary[] {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [...capabilities];
  return capabilities.filter((capability) => [capability.id, capability.name, capability.description].some((value) => normalizeQuery(value).includes(normalized)));
}