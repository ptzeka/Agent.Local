import { describe, expect, test } from "@jest/globals";

import type { ILogger } from "@agent-local/common/ilogger";
import {
  OtelLogger,
  OtelMetrics,
  TelemetryRegistry,
} from "@agent-local/common/telemetry/index";

// the OTel API is a no-op until an SDK is registered, so these assert the seam's contract:
// the logger forwards every level to its fallback, metrics record without throwing, and the
// registry hands back what was added.
describe("telemetry", () => {
  describe("OtelLogger", () => {
    test("forwards every level to the fallback logger", () => {
      const seen: Array<{ level: string; message: string; args: unknown[] }> = [];
      const fallback: ILogger = {
        error: (m, ...a) => seen.push({ level: "error", message: m, args: a }),
        warn: (m, ...a) => seen.push({ level: "warn", message: m, args: a }),
        info: (m, ...a) => seen.push({ level: "info", message: m, args: a }),
        debug: (m, ...a) => seen.push({ level: "debug", message: m, args: a }),
      };
      const logger = new OtelLogger(fallback);

      logger.error("e", 1);
      logger.warn("w");
      logger.info("i", "x");
      logger.debug("d");

      expect(seen).toEqual([
        { level: "error", message: "e", args: [1] },
        { level: "warn", message: "w", args: [] },
        { level: "info", message: "i", args: ["x"] },
        { level: "debug", message: "d", args: [] },
      ]);
    });
  });

  describe("OtelMetrics", () => {
    test("records without throwing while the meter is a no-op", () => {
      const metrics = new OtelMetrics();
      expect(() => {
        metrics.addToCounter("calls");
        metrics.addToCounter("calls", 3, { role: "orchestrator" });
        metrics.recordHistogram("latency_ms", 42, { role: "executor" });
      }).not.toThrow();
    });
  });

  describe("TelemetryRegistry", () => {
    test("returns the added telemetry by intent", () => {
      const logger = new OtelLogger();
      const metrics = new OtelMetrics();
      const registry = new TelemetryRegistry();
      registry.add({ logger, metrics });

      expect(registry.logger()).toBe(logger);
      expect(registry.metrics()).toBe(metrics);
    });

    test("throws when nothing has been added yet", () => {
      expect(() => new TelemetryRegistry().logger()).toThrow(/no telemetry added/);
    });
  });
});
