// dummy long-running tool for testing; written multi-session safe (its state assumes no single caller)
// stateful by necessity: `stop` must reach running waits, so it subclasses LocalMcp to track a controller per delay
// the runtime signal bounds its lifetime so shutdown clears pending timers instead of leaving waits dangling

import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import { LocalMcp, type LocalTool } from "@agent-local/mcp";
import type { ToolExecutionResult } from "@agent-local/mcp";

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
  // one controller per running delay; `stop` aborts them all, completion removes its own
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
        // the call's cutoff ends this wait the same way `stop` does; the tool only observes the abort
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

  // clears the timer and listeners on every path so a cancelled wait leaves nothing pending
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

export function createDelayLocalMcp(signal: AbortSignal): DelayLocalMcp {
  return new DelayLocalMcp(signal);
}
