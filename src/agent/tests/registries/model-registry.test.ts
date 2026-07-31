import { describe, expect, test } from "@jest/globals";

import { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ModelDefinition, ModelsFile, RoleDefinition } from "../../src/agent/registries/configuration-registry.js";

// maps logical roles onto declared models and serves each ROLE's own knobs (mcp whitelist, tool timeout);
// `models` carries pure model config only. Loading/parsing lives in ConfigurationRegistry, so the registry
// is constructed directly from an in-memory ModelsFile here
const base: ModelDefinition = { provider: "ollama", model: "x", supportsTools: true };

const defaultRoles: Record<string, Partial<RoleDefinition>> = {
  orchestrator: { model: "m-orch" },
  executor: { model: "m-exec" },
};

function makeRegistry(
  models: Record<string, ModelDefinition>,
  roleDefs: Record<string, Partial<RoleDefinition>> = defaultRoles
): ModelRegistry {
  const roles: Record<string, RoleDefinition> = {};
  for (const [role, def] of Object.entries(roleDefs)) {
    roles[role] = { prompt: role, completion: "self-terminate", model: "m-orch", ...def };
  }
  const modelsFile: ModelsFile = { models, roles, orchestration: {}, summaryWordThreshold: 2 };
  return new ModelRegistry(modelsFile);
}

const bothModels = { "m-orch": { ...base }, "m-exec": { ...base } };

describe("ModelRegistry", () => {
  test("getProviderForRole maps a role to its assigned model", () => {
    const registry = makeRegistry(bothModels);
    expect(registry.getProviderForRole("orchestrator")).toBe("m-orch");
    expect(registry.getProviderForRole("executor")).toBe("m-exec");
  });

  test("getValidMcpServersForRole returns the role's own MCP whitelist", () => {
    const registry = makeRegistry(bothModels, {
      orchestrator: { model: "m-orch", mcp: ["fsmcp"] },
      executor: { model: "m-exec", mcp: ["codemcp"] },
    });
    expect(registry.getValidMcpServersForRole("orchestrator")).toEqual(["fsmcp"]);
    expect(registry.getValidMcpServersForRole("executor")).toEqual(["codemcp"]);
  });

  test("getValidMcpServersForRole defaults to an empty list when mcp is omitted", () => {
    const registry = makeRegistry(bothModels);
    expect(registry.getValidMcpServersForRole("orchestrator")).toEqual([]);
  });

  test("two roles on the same model keep their own whitelists", () => {
    const registry = makeRegistry({ shared: { ...base } }, {
      orchestrator: { model: "shared", mcp: ["fsreadonly"] },
      executor: { model: "shared", mcp: ["fsmcp"] },
    });
    expect(registry.getValidMcpServersForRole("orchestrator")).toEqual(["fsreadonly"]);
    expect(registry.getValidMcpServersForRole("executor")).toEqual(["fsmcp"]);
  });

  test("getTimeoutForRole returns the role value, or the default when omitted", () => {
    const registry = makeRegistry(bothModels, {
      orchestrator: { model: "m-orch", toolTimeoutMs: 600000 },
      executor: { model: "m-exec" },
    });
    expect(registry.getTimeoutForRole("orchestrator")).toBe(600000);
    expect(registry.getTimeoutForRole("executor")).toBe(60000); // DEFAULT_TOOL_TIMEOUT_MS
  });

  test("getRoles lists every assigned role", () => {
    const registry = makeRegistry(bothModels);
    expect(registry.getRoles().sort()).toEqual(["executor", "orchestrator"]);
  });

  test("getValidModels lists the models that back a role", () => {
    const registry = makeRegistry(bothModels);
    expect(registry.getValidModels().sort()).toEqual(["m-exec", "m-orch"]);
  });

  test("getPromptTemplate returns a non-empty template per known role and rejects unknown ones", () => {
    const registry = makeRegistry(bothModels);
    expect(registry.getPromptTemplate("orchestrator").length).toBeGreaterThan(0);
    expect(registry.getPromptTemplate("executor").length).toBeGreaterThan(0);
    expect(() => registry.getPromptTemplate("unknown")).toThrow(/No prompt template/);
  });

  test("getAnchorText embeds the request verbatim in the anchor", () => {
    const registry = makeRegistry(bothModels);
    const anchor = registry.getAnchorText("delete hello_world.txt");
    expect(anchor).toContain("«delete hello_world.txt»");
    expect(anchor).not.toContain("{REQUEST}"); // placeholder must be consumed
  });

  test("construction rejects a role assigned to a model that is not defined", () => {
    expect(() =>
      makeRegistry({ "m-orch": { ...base } }, { orchestrator: { model: "m-orch" }, executor: { model: "ghost" } })
    ).toThrow(/not defined in models.json/);
  });

  test("getProviderForRole throws for a role that is not defined", () => {
    const registry = makeRegistry(bothModels);
    expect(() => registry.getProviderForRole("evaluator")).toThrow(/No role "evaluator" defined/);
  });

  test("assignRole repoints a role and rejects an undefined model", () => {
    const registry = makeRegistry(bothModels);
    registry.assignRole("orchestrator", "m-exec");
    expect(registry.getProviderForRole("orchestrator")).toBe("m-exec");
    expect(() => registry.assignRole("orchestrator", "missing")).toThrow(/not defined/);
  });
});
