import fs from "node:fs";
import path from "node:path";

import type { UsageTotals } from "../../session/session.js";

// one cumulative snapshot of a session's token tally; a later line for the same sessionId supersedes earlier ones
export interface MetricsRecord extends UsageTotals {
  ts: string;
  sessionId: string;
  parentSessionId?: string;
}

// out-of-band JSONL sink for token accounting, mirroring FileLogger: a later line per sessionId wins,
// so the file is read by folding to the last record bearing an id — local-dev shape until a metrics repository lands
// appends are synchronous: volume is one line per turn, order matters, and a sync write can't be lost on exit
export class MetricsStore {
  private readonly file: string;

  constructor(file?: string) {
    this.file = file ?? resolveMetricsFile();
  }

  public append(record: MetricsRecord): void {
    try {
      // dir made here, not in the ctor, so merely constructing a registry (which seeds via latestFor) writes nothing
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch {
      // a metrics-write failure must never break the thing being measured
    }
  }

  // the session's current total is the LAST line bearing its id; absent on first run, so the caller seeds from zero
  public latestFor(sessionId: string): MetricsRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      // no file yet (first run) — nothing to seed from
      return null;
    }
    let latest: MetricsRecord | null = null;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line) as MetricsRecord;
        if (record.sessionId === sessionId) latest = record;
      } catch {
        // a torn or partial line never invalidates the rest of the file
      }
    }
    return latest;
  }
}

// AGENT_METRICS_FILE wins; else cwd/metrics/metrics.jsonl, sibling to the logs/ directory
function resolveMetricsFile(): string {
  return process.env.AGENT_METRICS_FILE
    ? path.resolve(process.env.AGENT_METRICS_FILE)
    : path.resolve(process.cwd(), "metrics", "metrics.jsonl");
}
