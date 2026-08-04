import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/index.js";
describe("MCP scaffold", () => { it("constructs the read-only server", () => { expect(createServer()).toBeDefined(); }); });