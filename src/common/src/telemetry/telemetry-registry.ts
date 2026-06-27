import type { ILogger } from "../ilogger.js";
import type { IMetrics } from "./imetrics.js";

// the telemetry instances a runtime makes available to its consumers
export interface Telemetry {
  logger: ILogger;
  metrics: IMetrics;
}

// stateless holder/lookup: bootstrap constructs the telemetry and adds it once; consumers resolve
// logger()/metrics() by intent without knowing how either was built or where it exports to
export class TelemetryRegistry {
  private telemetry?: Telemetry;

  add(telemetry: Telemetry): void {
    this.telemetry = telemetry;
  }

  logger(): ILogger {
    return this.require().logger;
  }

  metrics(): IMetrics {
    return this.require().metrics;
  }

  private require(): Telemetry {
    if (!this.telemetry) throw new Error("TelemetryRegistry: no telemetry added yet — call add() at bootstrap");
    return this.telemetry;
  }
}
