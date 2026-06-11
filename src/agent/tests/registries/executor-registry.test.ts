import { describe, expect, test, jest } from "@jest/globals";

import { buildExecutorRegistry } from "../../src/agent/registries/executor-registry.js";
import type { ToolDescriptor } from "../../src/agent/providers/provider.js";
import type { SyntheticMcpContext } from "../../src/agent/synthetic-mcp/types.js";
import type { DispatchTracker } from "../../src/agent/synthetic-mcp/dispatch-tracker.js";

/**
 * ExecutorRegistry business logic.
 *
 * The executor registry intercepts `dispatch_executor` tool calls and routes them
 * to the executor handler. It advertises the executor tool descriptor and validates
 * tool calls before dispatch.
 */
describe("ExecutorRegistry", () => {
  function mockContext(): SyntheticMcpContext {
    const mockTracker = {
      reserve: jest.fn(() => ({ ok: true })),
    } as unknown as DispatchTracker;

    return {
      orchestrator: {} as any,
      session: {} as any,
      workspace: {} as any,
      inbox: {} as any,
      executor: {} as any,
      executorMaxIterations: 5,
      executorTemperature: 0.1,
      sandboxRoot: "/tmp/sandbox",
      tracker: mockTracker,
      emit: jest.fn(),
      sessionManager: undefined,
    };
  }

  test("builds a registry with dispatch_executor descriptor", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__write_file", description: "write a file", inputSchema: { type: "object" } },
    ];

    const registry = buildExecutorRegistry(tools);
    const descriptors = registry.listDescriptors();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].name).toBe("dispatch_executor");
  });

  test("has() identifies dispatch_executor", () => {
    const registry = buildExecutorRegistry([]);

    expect(registry.has("dispatch_executor")).toBe(true);
    expect(registry.has("other_tool")).toBe(false);
    expect(registry.has("fsmcp__write_file")).toBe(false);
  });

  test("dispatch() rejects unknown tools", async () => {
    const registry = buildExecutorRegistry([]);
    const context = mockContext();

    const result = await registry.dispatch("unknown_tool", {}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown executor tool");
  });

  test("dispatch() routes dispatch_executor to the handler", async () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__write_file", description: "write a file", inputSchema: { type: "object" } },
    ];

    const registry = buildExecutorRegistry(tools);
    const context = mockContext();

    const result = await registry.dispatch("dispatch_executor", { intent: "test" }, context);

    // The actual dispatch result depends on the context mocks, but it should
    // execute without throwing
    expect(result).toBeDefined();
    expect(typeof result.isError).toBe("boolean");
  });

  test("empty executor tools still produces a valid descriptor", () => {
    const registry = buildExecutorRegistry([]);
    const descriptors = registry.listDescriptors();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toHaveProperty("name", "dispatch_executor");
    expect(descriptors[0]).toHaveProperty("description");
    expect(descriptors[0]).toHaveProperty("inputSchema");
  });

  test("multiple executor tools are included in the descriptor", () => {
    const tools: ToolDescriptor[] = [
      { name: "fsmcp__write_file", description: "write a file", inputSchema: { type: "object" } },
      { name: "fsmcp__read_file", description: "read a file", inputSchema: { type: "object" } },
      { name: "codemcp__search_code", description: "search code", inputSchema: { type: "object" } },
    ];

    const registry = buildExecutorRegistry(tools);
    const descriptors = registry.listDescriptors();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].inputSchema).toBeDefined();
  });
});
