import { useCallback, useEffect, useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import { useHealth } from "../components/shared/useHealth";
import { searchWorks, getWork, createWork, stopWork, type WorkRecord } from "../components/shared/worksApi";
import { Permissions } from "../providers/user_context";
import type IPage from "./IPage";

// guarded page — routeConfig wraps it in AuthorizedRoute(Permissions.WorkflowRead)
export const Page: IPage = { pageName: "workflow", displayLabel: "Workflow", permission: Permissions.WorkflowRead };

const DEFAULT_WORKFLOW_ID = "agent-execute-process";

// status -> chip color; terminal-good is green, terminal-bad red, in-flight info, stopped/idle neutral
const statusColor = (status: WorkRecord["status"]) => {
  if (status === "completed") return "success" as const;
  if (status === "error") return "error" as const;
  if (status === "running") return "info" as const;
  if (status === "stopped" || status === "cancelled") return "warning" as const;
  return "default" as const;
};

const dash = (v: string | null): string => v ?? "—";

export default function WorkflowPage() {
  // composite host liveness pinged once on page load: Camunda link + the separate agent service's /healthz
  const health = useHealth();
  const [works, setWorks] = useState<WorkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState(DEFAULT_WORKFLOW_ID);
  const [opened, setOpened] = useState<string | null>(null); // the workId currently focused, if any

  // refresh = re-call the SAME search/get API: refetch the opened work alone, else the whole list
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      if (opened) {
        const work = await getWork(opened);
        setWorks((prev) => prev.map((w) => (w.jobId === work.jobId ? work : w)));
      } else {
        setWorks(await searchWorks());
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [opened]);

  // initial load + whenever the focus (opened) changes
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refresh button: re-probe readiness AND re-run the last search/get in one go
  const healthRefresh = health.refresh;
  const onRefresh = useCallback(async (): Promise<void> => {
    await Promise.all([healthRefresh(), refresh()]);
  }, [healthRefresh, refresh]);

  const onStart = async (): Promise<void> => {
    setError(null);
    try {
      await createWork(workflowId.trim() || DEFAULT_WORKFLOW_ID);
      setOpened(null); // back to the list so the new work shows
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  const onStop = async (workId: string): Promise<void> => {
    setError(null);
    try {
      const work = await stopWork(workId);
      setWorks((prev) => prev.map((w) => (w.jobId === work.jobId ? work : w)));
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h4">Workflows</Typography>
        <Tooltip
          title={
            health.loading
              ? "pinging /health/ready…"
              : `camunda: ${health.camunda ? "up" : "down"} · agent: ${health.agent ? "up" : "down"}`
          }
        >
          <Chip
            label={health.loading ? "checking…" : health.ok ? "live" : "offline"}
            color={health.loading ? "default" : health.ok ? "success" : "error"}
            size="small"
          />
        </Tooltip>
        <Button onClick={() => void onRefresh()} disabled={loading} size="small" variant="outlined">
          {loading ? "Refreshing…" : opened ? "Refresh work" : "Refresh"}
        </Button>
        {opened && (
          <Button onClick={() => setOpened(null)} size="small">
            Show all
          </Button>
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary">
        Your work units — fetched on load; use Refresh to refetch (no live stream). Start one below, Stop a running one.
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center">
        <TextField
          label="Workflow id"
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          size="small"
        />
        <Tooltip
          title={
            health.loading
              ? "checking Camunda readiness…"
              : !health.camunda
                ? "Camunda is offline — start a work once /health/ready reports it up"
                : ""
          }
        >
          {/* span so the tooltip still shows while the button is disabled */}
          <span>
            <Button
              onClick={() => void onStart()}
              variant="contained"
              size="small"
              disabled={health.loading || !health.camunda}
            >
              Start work
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {error && (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      )}

      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Work</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Step</TableCell>
              <TableCell>Camunda</TableCell>
              <TableCell>Agent session</TableCell>
              <TableCell>Updated</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {works.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    {loading ? "Loading…" : "No work yet. Start a workflow above to see it here."}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              works.map((w) => {
                const stoppable = w.status === "new" || w.status === "running" || w.status === "stuck";
                return (
                  <TableRow
                    key={w.jobId}
                    hover
                    selected={opened === w.jobId}
                    onClick={() => setOpened(w.jobId)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell>{w.jobId.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Tooltip title={w.reason ?? ""} disableHoverListener={!w.reason}>
                        <Chip label={w.status} color={statusColor(w.status)} size="small" />
                      </Tooltip>
                    </TableCell>
                    <TableCell>{dash(w.step)}</TableCell>
                    <TableCell>{dash(w.camundaId)}</TableCell>
                    <TableCell>{dash(w.sessionId)}</TableCell>
                    <TableCell>{new Date(w.ts).toLocaleTimeString()}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="warning"
                        disabled={!stoppable}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onStop(w.jobId);
                        }}
                      >
                        Stop
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
