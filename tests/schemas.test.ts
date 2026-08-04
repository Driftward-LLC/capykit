import { describe, expect, it } from "vitest";
import { REGISTRY_SCHEMA_VERSION, registrySchemaUrl } from "../src/schemas/index.js";
describe("schema package boundary", () => { it("exposes the versioned registry schema", () => { expect(REGISTRY_SCHEMA_VERSION).toBe("0.1.0"); expect(registrySchemaUrl().pathname).toMatch(/schemas\/v0\.1\/registry\.schema\.json$/); }); });