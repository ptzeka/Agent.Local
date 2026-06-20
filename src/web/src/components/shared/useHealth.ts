import { useApiClient } from "@/providers/api_context";
import { useApiQuery } from "@/components/shared/useApi";

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

// pings the host's composite /health/ready ONCE per mount (a readiness snapshot) and again on refresh().
// a 503 is EXPECTED when a dependency is down, so this call alone bypasses the throw-on-non-2xx interceptor
// (validateStatus) to keep the workflow/agent breakdown from the body; only a thrown request reads as fully down.
export function useHealth(): HealthState {
  const client = useApiClient();
  const { data, loading, refresh } = useApiQuery<Health>(async () => {
    try {
      const res = await client.get<Partial<Health>>("/health/ready", { validateStatus: () => true });
      const body = res.data ?? {};
      const ok = res.status >= 200 && res.status < 300;
      return { ok, workflow: !!body.workflow, agent: !!body.agent };
    } catch {
      return { ok: false, workflow: false, agent: false };
    }
  }, [client]);

  return { loading, refresh, ok: data?.ok, workflow: data?.workflow, agent: data?.agent };
}
