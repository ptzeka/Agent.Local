/**
 * In-process "delay" MCP server — a dummy long-running tool for testing.
 *
 * Treat this as a standalone, singleton MCP server: it is mounted per-runtime
 * today, but its contract is written as if one instance served every session at
 * once. So its state is held multi-session safe — `active` below collects
 * controllers from concurrent `delay` calls without assuming a single caller.
 *
 * Exposes two tools:
 *   - `delay` waits `time` milliseconds and resolves with "done".
 *   - `stop` cancels every in-flight `delay`. The cancel is intentionally global
 *     across all callers — any concurrent call can release a blocked wait. For a
 *     dummy test tool that is the documented contract, not a cross-session leak.
 *
 * Stateful by necessity: `stop` must reach running waits, so the server tracks
 * one AbortController per active delay. That requires a subclass (handlers close
 * over `this`), registering each tool one-by-one after super() per the LocalMcp
 * convention. A tool call stays a plain in-process function call — no transport.
 *
 * The runtime abort signal bounds the singleton's lifetime: a shutdown clears
 * every pending timer instead of leaving long waits dangling past teardown.
 *
 * Architecture role: Repository / External layer. No agent logic — timers only.
 */

import type { ToolDescriptor } from "../providers/provider.js";
import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import type { ToolExecutionResult } from "../mcp/mcp.js";

/** The MCP server name this module mounts under (tools namespace as `delaymcp__*`). */
export const DELAY_SERVER_NAME = "delaymcp";

const DELAY_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "delay",
  description: "Wait for the given number of milliseconds, then respond with \"done\". A dummy long-running tool for testing.",
  inputSchema: {
    type: "object",
    properties: {
      time: {
        type: "integer",
        minimum: 0,
        description: "How long to wait, in milliseconds.",
      },
    },
    required: ["time"],
    additionalProperties: false,
  },
};

const STOP_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "stop",
  description: "Cancel every in-flight `delay` call. Responds with how many were stopped.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export class DelayLocalMcp extends LocalMcp {
  // One controller per running delay, pooled across all callers of this
  // singleton server; `stop` aborts them all, completion removes its own.
  private readonly active = new Set<AbortController>();

  constructor(private readonly runtimeSignal: AbortSignal) {
    super(DELAY_SERVER_NAME, []);
    this.registerTool(this.delayTool());
    this.registerTool(this.stopTool());
  }

  private delayTool(): LocalTool {
    return {
      descriptor: DELAY_TOOL_DESCRIPTOR,
      invoke: async (args, cutoffscope): Promise<ToolExecutionResult> => {
        const time = (args ?? {}).time;
        if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
          return { isError: true, content: "`time` must be a non-negative number of milliseconds." };
        }

        const controller = new AbortController();
        this.active.add(controller);
        // The call's cutoff (a parent cancel OR the server's timeout) ends this
        // wait the same way `stop` does — the tool only ever observes the abort.
        const callerSignal = cutoffscope.signal;
        const onCallerAbort = (): void => controller.abort();
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        try {
          await this.wait(time, controller.signal);
          return { isError: false, content: "done" };
        } catch (err) {
          return { isError: true, content: (err as Error).message };
        } finally {
          callerSignal.removeEventListener("abort", onCallerAbort);
          this.active.delete(controller);
        }
      },
    };
  }

  private stopTool(): LocalTool {
    return {
      descriptor: STOP_TOOL_DESCRIPTOR,
      invoke: async (): Promise<ToolExecutionResult> => {
        const stopped = this.active.size;
        for (const controller of this.active) {
          controller.abort();
        }
        return { isError: false, content: `stopped ${stopped}` };
      },
    };
  }

  /**
   * Resolve after `ms`, or reject early if the per-delay controller or the
   * runtime signal aborts — clearing the timer and listeners either way so a
   * cancelled wait leaves nothing pending.
   */
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.runtimeSignal.aborted) {
        reject(new Error("Delay aborted before it started."));
        return;
      }

      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.runtimeSignal.removeEventListener("abort", onAbort);
      };

      const onAbort = (): void => {
        cleanup();
        reject(new Error("Delay stopped."));
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      signal.addEventListener("abort", onAbort, { once: true });
      this.runtimeSignal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Build the in-process delay server, bound to the runtime's abort signal. */
export function createDelayLocalMcp(signal: AbortSignal): DelayLocalMcp {
  return new DelayLocalMcp(signal);
}
