import { useCallback, useEffect, useState } from "react";

// the host's composite readiness (/health/ready): ok only when the workflow-engine link AND the separate agent
// service are both up. workflow/agent are the per-dependency legs, surfaced so a chip can explain *what* is down.
export interface Health {
  ok: boolean;
  workflow: boolean;
  agent: boolean;
}

export interface HealthState extends Partial<Health> {
  // true until the first /healthz answer lands; the chip renders a neutral "checking…" while loading
  loading: boolean;
  // re-probe /health/ready on demand (e.g. the Refresh button) — same snapshot the mount took
  refresh: () => Promise<void>;
}

// pings the host's composite /health/ready ONCE per mount (i.e. once per page load) — a readiness snapshot —
// and again whenever `refresh()` is called. A 503 is expected when a dependency is down, so we read the JSON
// body on any response to keep the workflow/agent breakdown; only a thrown fetch reads as fully down.
export function useHealth(): HealthState {
  const [state, setState] = useState<Omit<HealthState, "refresh">>({ loading: true });

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined") return; // client-only; SSR never probes
    try {
      const r = await fetch("/health/ready");
      const body = (await r.json().catch(() => ({}))) as Partial<Health>;
      setState({ loading: false, ok: r.ok, workflow: !!body.workflow, agent: !!body.agent });
    } catch {
      setState({ loading: false, ok: false, workflow: false, agent: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
