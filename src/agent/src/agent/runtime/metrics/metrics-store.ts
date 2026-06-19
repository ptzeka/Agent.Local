import type { DatabaseHandle } from "@agent-local/common/db";

import type { UsageTotals } from "../../session/session.js";

// one cumulative snapshot of a session's token tally; a later write for the same sessionId supersedes earlier ones
export interface MetricsRecord extends UsageTotals {
  ts: string;
  sessionId: string;
  parentSessionId?: string;
}

// token accounting on agent.sqlite: one upserted `metrics` row per session (last-write-wins collapses the old
// JSONL "last line wins" to a single row). The DB handle is opened once at startup and injected.
// writes are best-effort: a metrics-write failure must never break the thing being measured
export class MetricsStore {
  constructor(private readonly db: DatabaseHandle) {}

  public append(record: MetricsRecord): void {
    try {
      this.db
        .prepare(
          "INSERT INTO metrics (session_id, parent_session_id, payload, updated_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, payload = excluded.payload, updated_at = excluded.updated_at",
        )
        .run(record.sessionId, record.parentSessionId ?? null, JSON.stringify(record), record.ts);
    } catch {
      // a metrics-write failure must never break the thing being measured
    }
  }

  // the session's current total is its single upserted row; absent on first run, so the caller seeds from zero
  public latestFor(sessionId: string): MetricsRecord | null {
    try {
      const row = this.db
        .prepare("SELECT payload FROM metrics WHERE session_id = ?")
        .get(sessionId) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as MetricsRecord) : null;
    } catch {
      // a torn or missing row never invalidates the seed; start from zero
      return null;
    }
  }
}
