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
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useHealth } from "../components/shared/useHealth";
import { searchWorks, getWork, createWork, stopWork, continueWork, getStatusCodes, getWorkflows, type WorkRecord, type StatusCode, type WorkflowTemplate } from "../components/shared/worksApi";
import { Permissions } from "../providers/user_context";
import type IPage from "./IPage";

// guarded page — routeConfig wraps it in AuthorizedRoute(Permissions.WorkflowRead)
export const Page: IPage = { pageName: "workflow", displayLabel: "Workflow", permission: Permissions.WorkflowRead };

// the only UI-local status knowledge: maps the host's presentation-neutral `tone` to an MUI chip color. Everything
// else (which statuses exist, their labels, which are terminal/stoppable/continuable) comes from the host catalog.
type ChipColor = "default" | "info" | "warning" | "error" | "success";
const toneColor: Record<StatusCode["tone"], ChipColor> = {
  neutral: "default",
  active: "info",
  warn: "warning",
  error: "error",
  success: "success",
};

const dash = (v: string | null): string => v ?? "—";

export default function WorkflowPage() {
  // composite host liveness pinged once on page load: workflow-engine link + the separate agent service's /healthz
  const health = useHealth();
  const [works, setWorks] = useState<WorkRecord[]>([]);
  const [statusCodes, setStatusCodes] = useState<Map<string, StatusCode>>(new Map());
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState(""); // the selected workflow type; defaults to the first catalog entry once loaded
  const [opened, setOpened] = useState<string | null>(null); // the workId currently focused, if any

  // load the status catalog once: labels, chip tone, and per-status action rules all come from the host lookup
  useEffect(() => {
    void getStatusCodes()
      .then((codes: StatusCode[]) => setStatusCodes(new Map(codes.map((c: StatusCode) => [c.status, c]))))
      .catch((err: unknown) => {
        // a missing catalog degrades gracefully (rows fall back to raw status + no actions), but log so the break is visible
        console.error("[workflow] failed to load status catalog:", err);
      });
  }, []);

  // load the workflow catalog once: the Start dropdown is sourced from the host (code-defined), not hardcoded.
  // default the selection to the first template so Start is immediately usable.
  useEffect(() => {
    void getWorkflows()
      .then((templates: WorkflowTemplate[]) => {
        setWorkflows(templates);
        if (templates.length > 0) setWorkflowId(templates[0].name);
      })
      .catch((err: unknown) => {
        // no catalog -> empty dropdown -> Start stays disabled; log so a wiring break is visible rather than silent
        console.error("[workflow] failed to load workflow catalog:", err);
      });
  }, []);

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
      await createWork(workflowId);
      setOpened(null); // back to the list so the new work shows
      await refresh();
    } catch (err) {
      console.error("[workflow] start failed:", err);
      setError(String(err));
    }
  };

  // one-row mutators share the same fold: swap just the touched row, surface any error inline
  const replaceRow = (work: WorkRecord): void =>
    setWorks((prev) => prev.map((w) => (w.jobId === work.jobId ? work : w)));

  const onStop = async (workId: string): Promise<void> => {
    setError(null);
    try {
      replaceRow(await stopWork(workId));
    } catch (err) {
      setError(String(err));
    }
  };

  // continue = engine Reset of a stuck step; the host 409s a non-stuck work, surfaced as the inline error
  const onContinue = async (workId: string): Promise<void> => {
    setError(null);
    try {
      replaceRow(await continueWork(workId));
    } catch (err) {
      setError(String(err));
    }
  };

  // per-row refresh: re-GET this work alone (the GET also kicks a Temporal reconcile for the next read)
  const onRefreshRow = async (workId: string): Promise<void> => {
    setError(null);
    try {
      replaceRow(await getWork(workId));
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
              : `workflow: ${health.workflow ? "up" : "down"} · agent: ${health.agent ? "up" : "down"}`
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
        Your work units — fetched on load; no live stream. Per row: Stop a running one, Continue (re-run) a stuck one, or Refresh just that row.
      </Typography>

      <Stack direction="row" spacing={2} alignItems="center">
        <TextField
          select
          label="Workflow"
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          size="small"
          sx={{ minWidth: 220 }}
          disabled={workflows.length === 0}
          helperText={workflows.length === 0 ? "No workflow available" : undefined}
        >
          {workflows.map((wf) => (
            <MenuItem key={wf.name} value={wf.name}>
              {wf.label}
            </MenuItem>
          ))}
        </TextField>
        <Tooltip
          title={
            health.loading
              ? "checking workflow-engine readiness…"
              : !health.workflow
                ? "Workflow engine is offline — start a work once /health/ready reports it up"
                : !workflowId
                  ? "No workflow selected"
                  : ""
          }
        >
          {/* span so the tooltip still shows while the button is disabled */}
          <span>
            <Button
              onClick={() => void onStart()}
              variant="contained"
              size="small"
              disabled={health.loading || !health.workflow || !workflowId}
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
              <TableCell>Temporal</TableCell>
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
                // all status semantics come from the host catalog; an unknown status (catalog miss) renders inert
                const code = statusCodes.get(w.status);
                const terminal = code?.terminal ?? false;
                const stoppable = code?.stoppable ?? false;
                const continuable = code?.continuable ?? false;
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
                      <Tooltip title={w.statusDescription ?? ""} disableHoverListener={!w.statusDescription}>
                        <Chip
                          label={code?.label ?? w.status}
                          color={code ? toneColor[code.tone] : "default"}
                          size="small"
                        />
                      </Tooltip>
                    </TableCell>
                    <TableCell>{dash(w.step)}</TableCell>
                    <TableCell>{dash(w.temporalId)}</TableCell>
                    <TableCell>{dash(w.sessionId)}</TableCell>
                    <TableCell>{new Date(w.ts).toLocaleTimeString()}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Stop">
                        <span>
                          <IconButton
                            size="small"
                            color="warning"
                            disabled={!stoppable}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onStop(w.jobId);
                            }}
                          >
                            <StopCircleIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Continue (re-run the stuck step)">
                        <span>
                          <IconButton
                            size="small"
                            color="primary"
                            disabled={!continuable}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onContinue(w.jobId);
                            }}
                          >
                            <PlayArrowIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Refresh this work">
                        <span>
                          <IconButton
                            size="small"
                            disabled={terminal}
                            onClick={(e) => {
                              e.stopPropagation();
                              void onRefreshRow(w.jobId);
                            }}
                          >
                            <RefreshIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
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
