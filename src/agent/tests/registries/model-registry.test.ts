import { afterEach, describe, expect, test } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModelRegistry } from "../../src/agent/registries/model-registry.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";

/**
 * ModelRegistry.filterMcpByServerWhitelist: the per-model MCP server whitelist from
 * models.json, layered on top of the (already applied) role split. MCP server
 * names are matched on the tool name prefix (before `__`).
 */

const TOOLS: ToolDescriptor[] = [
  { name: "fsmcp__read_file", description: "", inputSchema: { type: "object" } },
  { name: "fsmcp__write_file", description: "", inputSchema: { type: "object" } },
  { name: "codemcp__search_code", description: "", inputSchema: { type: "object" } },
];

const base = { provider: "ollama", model: "x", supportsTools: true };

describe("ModelRegistry.filterMcpByServerWhitelist", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  /** Write a temp models.json and load a real registry from it (ollama-only, key-free). */
  async function loadRegistry(models: Record<string, unknown>): Promise<ModelRegistry> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-reg-"));
    cleanup = () => fs.rm(dir, { recursive: true, force: true });
    const file = path.join(dir, "models.json");
    await fs.writeFile(
      file,
      JSON.stringify({ models, roles: { orchestrator: "m-orch", executor: "m-exec" } }),
      "utf8"
    );
    return ModelRegistry.load(file);
  }

  test("no whitelist returns the input list unchanged", async () => {
    const registry = await loadRegistry({ "m-orch": { ...base }, "m-exec": { ...base } });
    expect(registry.filterMcpByServerWhitelist("orchestrator", TOOLS)).toEqual(TOOLS);
  });

  test("a subset whitelist keeps only tools from whitelisted servers", async () => {
    const registry = await loadRegistry({
      "m-orch": { ...base, mcp: ["fsmcp"] },
      "m-exec": { ...base },
    });
    const kept = registry.filterMcpByServerWhitelist("orchestrator", TOOLS).map((t) => t.name);
    expect(kept).toEqual(["fsmcp__read_file", "fsmcp__write_file"]);
  });

  test("an empty mcp list removes every tool", async () => {
    const registry = await loadRegistry({
      "m-orch": { ...base, mcp: [] },
      "m-exec": { ...base },
    });
    expect(registry.filterMcpByServerWhitelist("orchestrator", TOOLS)).toEqual([]);
  });

  test("the mcp list is resolved per role from that role's model", async () => {
    const registry = await loadRegistry({
      "m-orch": { ...base, mcp: ["fsmcp"] },
      "m-exec": { ...base, mcp: ["codemcp"] },
    });
    expect(registry.filterMcpByServerWhitelist("orchestrator", TOOLS).map((t) => t.name)).toEqual([
      "fsmcp__read_file",
      "fsmcp__write_file",
    ]);
    expect(registry.filterMcpByServerWhitelist("executor", TOOLS).map((t) => t.name)).toEqual([
      "codemcp__search_code",
    ]);
  });
});
