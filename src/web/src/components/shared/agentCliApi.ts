// typed client over the host's interactive agent-cli BFF (/api/agent/cli/:workId), bound to the shared axios
// instance. The browser only ever talks to the host (same-origin session cookie, withCredentials); the host
// proxies to the agent under its own service token. This is the chat half of the work surface: provision the
// session, open the live SSE channel, push input, and Stop the in-flight turn.
import { useMemo } from "react";
import type { AxiosInstance } from "axios";
import { useApiClient } from "@/providers/api_context";

export interface AgentCliApi {
  // ensure the work has a cli session, idempotently (host reuses or mints); returns the agent sessionId
  provisionSession(workId: string): Promise<string>;
  // the live SSE read channel URL for an EventSource — same-origin so the session cookie authenticates it (an
  // EventSource cannot set an Authorization header, so cookie auth is load-bearing here)
  streamUrl(workId: string): string;
  // push one input turn (the write half; the SSE channel carries the answer back as delta/end frames)
  sendInput(workId: string, input: string): Promise<void>;
  // Stop the live turn without closing the session, so the chat stays usable for the next input
  stop(workId: string): Promise<void>;
}

export function createAgentCliApi(client: AxiosInstance): AgentCliApi {
  // the EventSource URL must be absolute against the same base the axios client uses (empty -> same-origin relative)
  const base = client.defaults.baseURL ?? "";
  return {
    async provisionSession(workId: string) {
      const { data } = await client.put<{ sessionId: string }>(`/api/agent/cli/${encodeURIComponent(workId)}`);
      return data.sessionId;
    },

    streamUrl(workId: string) {
      return `${base}/api/agent/cli/${encodeURIComponent(workId)}`;
    },

    async sendInput(workId: string, input: string) {
      await client.post(`/api/agent/cli/${encodeURIComponent(workId)}/input`, { input });
    },

    async stop(workId: string) {
      await client.post(`/api/agent/cli/${encodeURIComponent(workId)}/stop`, {});
    },
  };
}

// hook seam: the bound cli api, memoized against the shared client so consumers get a stable reference
export function useAgentCliApi(): AgentCliApi {
  const client = useApiClient();
  return useMemo(() => createAgentCliApi(client), [client]);
}
