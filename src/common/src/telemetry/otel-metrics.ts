import { metrics, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import type { IMetrics, MetricAttributes } from "./imetrics.js";

// IMetrics over the OTel metrics API. The global MeterProvider is a no-op until an SDK is
// registered, so today every record is silently dropped — intentional: no env, no fallback,
// an unexported metric has nowhere sane to go. Wiring an exporter later makes these live.
export class OtelMetrics implements IMetrics {
  private readonly meter: Meter;
  // instruments are cached by name: OTel requires one instrument object per metric, reused per record
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(meterName = "@agent-local/common") {
    this.meter = metrics.getMeter(meterName);
  }

  addToCounter(name: string, value = 1, attributes?: MetricAttributes): void {
    this.counterFor(name).add(value, attributes);
  }

  recordHistogram(name: string, value: number, attributes?: MetricAttributes): void {
    this.histogramFor(name).record(value, attributes);
  }

  private counterFor(name: string): Counter {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    return counter;
  }

  private histogramFor(name: string): Histogram {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }
}
