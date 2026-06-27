// attribute bag stamped on a measurement; kept to OTel-permitted scalar values so a record
// maps 1:1 onto an OTel `Attributes` object once an exporter is wired
export type MetricAttributes = Record<string, string | number | boolean>;

// the metrics surface consumers depend on, kept narrow and intent-named so callers record by
// meaning ("add to a counter", "record a distribution") without holding an OTel instrument handle
export interface IMetrics {
  addToCounter(name: string, value?: number, attributes?: MetricAttributes): void;
  recordHistogram(name: string, value: number, attributes?: MetricAttributes): void;
}
