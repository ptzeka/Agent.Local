import { describe, expect, test } from "@jest/globals";

import { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ModelsFile } from "../../src/agent/registries/configuration-registry.js";

// maps logical roles onto declared models and exposes each role model's per-model MCP server whitelist
// (the `mcp` array from models.json); loading/parsing lives in ConfigurationRegistry, so the registry is
// constructed directly from an in-memory ModelsFile here

const base = { provider: "ollama", model: "x", supportsTools: true };

function makeRegistry(
  models: Record<
    string,
    { provider: string; model: string; supportsTools: boolean; mcp?: string[]; toolTimeoutMs?: number; iterationCap?: number }
  >,
  roles: Record<string, string> = { orchestrator: "m-orch", executor: "m-exec" }
): ModelRegistry {
  const modelsFile: ModelsFile = { models, roles, orchestration: {} };
  return new ModelRegistry(modelsFile);
}

describe("ModelRegistry", () => {
  test("getProviderForRole maps a role to its assigned model", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.getProviderForRole("orchestrator")).toBe("m-orch");
    expect(registry.getProviderForRole("executor")).toBe("m-exec");
  });

  test("getValidMcpServersForRole returns the role model's MCP whitelist", () => {
    const registry = makeRegistry({
      "m-orch": { ...base, mcp: ["fsmcp"] },
      "m-exec": { ...base, mcp: ["codemcp"] },
    });
    expect(registry.getValidMcpServersForRole("orchestrator")).toEqual(["fsmcp"]);
    expect(registry.getValidMcpServersForRole("executor")).toEqual(["codemcp"]);
  });

  test("getValidMcpServersForRole defaults to an empty list when mcp is omitted", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.getValidMcpServersForRole("orchestrator")).toEqual([]);
  });

  test("getTimeoutForModel returns the model value, or the default when omitted", () => {
    const registry = makeRegistry({
      "m-orch": { ...base, toolTimeoutMs: 600000 },
      "m-exec": { ...base },
    });
    expect(registry.getTimeoutForModel("m-orch")).toBe(600000);
    expect(registry.getTimeoutForModel("m-exec")).toBe(60000); // DEFAULT_TOOL_TIMEOUT_MS
  });

  test("getIterationCapForModel returns the model value, or undefined when omitted", () => {
    const registry = makeRegistry({
      "m-orch": { ...base, iterationCap: 24 },
      "m-exec": { ...base },
    });
    expect(registry.getIterationCapForModel("m-orch")).toBe(24);
    expect(registry.getIterationCapForModel("m-exec")).toBeUndefined();
  });

  test("getRoles lists every assigned role", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.getRoles().sort()).toEqual(["executor", "orchestrator"]);
  });

  test("getValidModels lists the models that back a role", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.getValidModels().sort()).toEqual(["m-exec", "m-orch"]);
  });

  test("getPromptTemplate returns a non-empty template per known role and rejects unknown ones", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.getPromptTemplate("orchestrator").length).toBeGreaterThan(0);
    expect(registry.getPromptTemplate("executor").length).toBeGreaterThan(0);
    expect(() => registry.getPromptTemplate("unknown")).toThrow(/No prompt template/);
  });

  test("getAnchorText embeds the request verbatim in the anchor", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    const anchor = registry.getAnchorText("delete hello_world.txt");
    expect(anchor).toContain("«delete hello_world.txt»");
    expect(anchor).not.toContain("{REQUEST}"); // placeholder must be consumed
  });

  test("assignRole repoints a role and rejects an undefined model", () => {
    const registry = makeRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    registry.assignRole("orchestrator", "m-exec");
    expect(registry.getProviderForRole("orchestrator")).toBe("m-exec");
    expect(() => registry.assignRole("orchestrator", "missing")).toThrow(/not defined/);
  });
});
