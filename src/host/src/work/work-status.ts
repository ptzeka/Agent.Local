// the single source of truth for the work-unit status domain. Both the DB lookup table (db-schema seeds
// work_status from this) and the /api/works/statuscodes endpoint derive from it, so the set of statuses, their
// labels, presentation, and lock semantics are defined ONCE and the UI never hardcodes them.
//
// `tone` is a presentation-neutral semantic (not an MUI color) so the host domain stays free of UI vocabulary;
// the web layer maps tone -> chip color. `terminal` is the only lifecycle flag: a terminal work is settled and
// fully locked (its action bar is inert); every non-terminal status keeps ALL actions available.
export type StatusTone = "neutral" | "active" | "success" | "attention";

export interface StatusCode {
  status: string;
  label: string;
  tone: StatusTone;
  terminal: boolean;
}

// four STORED states, each written by a reliable engine-event fold (reconcile is the miss-recovery backstop):
//   new       — provisioned, no engine instance yet
//   running   — a live workflow (WORKFLOW_STARTED)
//   attention — the single non-terminal STOPPED state: any stop or end that isn't a clean completion — user Stop,
//               engine canceled, WORKFLOW_FAILED, or reconcile finding failed/timedOut/terminated. Orange,
//               recovered via engine Reset. The ACTUAL per-step Temporal status (canceled etc.) shows at the step,
//               not the work — the work only says "stopped, needs attention".
//   complete  — the clean end (WORKFLOW_COMPLETED); the ONLY terminal, fully locked
// attention is a STORED status set by the event fold, not derived at read: the list is a pure DB read and the row
// colors orange the moment the stop/failure event lands.
export const WORK_STATUS_CODES = [
  { status: "new",       label: "New",       tone: "neutral",   terminal: false },
  { status: "running",   label: "Running",   tone: "active",    terminal: false },
  { status: "attention", label: "Attention", tone: "attention", terminal: false },
  { status: "complete",  label: "Complete",  tone: "success",   terminal: true  },
] as const satisfies ReadonlyArray<StatusCode>;

// the status union derived from the canonical list — adding a status to WORK_STATUS_CODES extends the type for free
export type WorkStatus = (typeof WORK_STATUS_CODES)[number]["status"];

// the terminal (fully-locked) statuses, derived from the catalog's `terminal` flag so the lock set stays defined
// once. A terminal work refuses every action — server-side enforcement, mirroring the UI's disabled action bar.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(WORK_STATUS_CODES.filter((s) => s.terminal).map((s) => s.status));

// whether a work in this status is settled and locked: true only for `complete` today. The action layer (work
// service + cli routes) gates on this so a `complete` work can never be stopped, reset, injected, or chatted.
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
