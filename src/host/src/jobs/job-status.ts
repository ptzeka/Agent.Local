// the single source of truth for the work-unit status domain. Both the DB lookup table (db-schema seeds
// job_status from this) and the /api/works/statuscodes endpoint derive from it, so the set of statuses, their
// labels, presentation, and action semantics are defined ONCE and the UI never hardcodes them.
//
// `tone` is a presentation-neutral semantic (not an MUI color) so the host domain stays free of UI vocabulary;
// the web layer maps tone -> chip color. The action flags express the work's lifecycle rules:
//   terminal     — settled; no engine instance left to act on (the whole row's action bar is inert)
//   stoppable    — a Stop can still cancel it
//   continuable  — a stuck step can be re-run via engine Reset
export type StatusTone = "neutral" | "active" | "warn" | "error" | "success";

export interface StatusCode {
  status: string;
  label: string;
  tone: StatusTone;
  terminal: boolean;
  stoppable: boolean;
  continuable: boolean;
}

// `done` is the engine's terminal signal (the workflow returned); `complete` is set only after the host's
// post-workflow tasks finish — observable apart. `stuck` is NOT terminal: it absorbs failures and is recoverable.
// `stopped` is the user's stop ACK and is NOT terminal either — it awaits the engine's cancel confirmation, so it
// still reconciles (Refresh stays live); `cancelled` is its terminal twin, set after that confirmation + cleanup.
export const JOB_STATUS_CODES = [
  { status: "new",       label: "New",       tone: "neutral", terminal: false, stoppable: true,  continuable: false },
  { status: "running",   label: "Running",   tone: "active",  terminal: false, stoppable: true,  continuable: false },
  { status: "stuck",     label: "Stuck",     tone: "error",   terminal: false, stoppable: true,  continuable: true  },
  { status: "stopped",   label: "Stopped",   tone: "warn",    terminal: false, stoppable: false, continuable: false },
  { status: "cancelled", label: "Cancelled", tone: "neutral", terminal: true,  stoppable: false, continuable: false },
  { status: "done",      label: "Done",      tone: "success", terminal: true,  stoppable: false, continuable: false },
  { status: "complete",  label: "Complete",  tone: "success", terminal: true,  stoppable: false, continuable: false },
] as const satisfies ReadonlyArray<StatusCode>;

// the status union derived from the canonical list — adding a status to JOB_STATUS_CODES extends the type for free
export type JobStatus = (typeof JOB_STATUS_CODES)[number]["status"];
