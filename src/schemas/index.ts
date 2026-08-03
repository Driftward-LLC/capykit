import { URL } from "node:url";

export const REGISTRY_SCHEMA_VERSION = "0.1.0";
export function registrySchemaUrl(): URL { return new URL("../schemas/v0.1/registry.schema.json", import.meta.url); }