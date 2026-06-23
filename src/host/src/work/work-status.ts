// the single source of truth for the work-unit status domain. Both the DB lookup table (db-schema seeds
// work_status from this) and the /api/works/statuscodes endpoint derive from it, so the set of statuses, their
// labels, presentation, and action semantics are defined ONCE and the UI never hardcodes them.
//
// `tone` is a presentation-neutral semantic (not an MUI color) so the host domain stays free of UI vocabulary;
// the web layer maps tone -> chip color. The action flags express the work's lifecycle rules:
//   terminal     — settled; no engine instance left to act on (the whole row's action bar is inert)
//   stoppable    — a Stop can still cancel it
//   continuable  — a stopped work can be picked back up (re-run via engine Reset)
export type StatusTone = "neutral" | "active" | "warn" | "error" | "success";

export interface StatusCode {
  status: string;
  label: string;
  tone: StatusTone;
  terminal: boolean;
  stoppable: boolean;
  continuable: boolean;
}

// five states mirroring the engine's own lifecycle. `new` = provisioned, no engine record yet; `running` = a live
// workflow. The three terminal states split by recoverability AND success: `completed` is the clean end (engine
// returned) and is NOT continuable — done is done; `stopped` is the user-cancel / orphan terminal (no failure), kept
// continuable so the work can be picked back up; `failed` is the engine-failure terminal (failed/timedOut/terminated),
// also continuable since the recovery path is the same engine Reset (continue/rerun) — it just reads as an error, not
// a benign stop, so the UI can distinguish "you stopped this" from "this broke".
export const WORK_STATUS_CODES = [
  { status: "new",       label: "New",       tone: "neutral", terminal: false, stoppable: true,  continuable: false },
  { status: "running",   label: "Running",   tone: "active",  terminal: false, stoppable: true,  continuable: false },
  { status: "stopped",   label: "Stopped",   tone: "warn",    terminal: true,  stoppable: false, continuable: true  },
  { status: "failed",    label: "Failed",    tone: "error",   terminal: true,  stoppable: false, continuable: true  },
  { status: "completed", label: "Completed", tone: "success", terminal: true,  stoppable: false, continuable: false },
] as const satisfies ReadonlyArray<StatusCode>;

// the status union derived from the canonical list — adding a status to WORK_STATUS_CODES extends the type for free
export type WorkStatus = (typeof WORK_STATUS_CODES)[number]["status"];
