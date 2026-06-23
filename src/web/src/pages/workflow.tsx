import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
import Collapse from "@mui/material/Collapse";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import RefreshIcon from "@mui/icons-material/Refresh";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import ClearIcon from "@mui/icons-material/Clear";
import { useHealth } from "@/components/shared/useHealth";
import { useWorksApi, type WorkRecord, type StatusCode, type WorkflowTemplate, type WorkflowStep } from "@/components/shared/worksApi";
import { useApiQuery, useApiMutation } from "@/components/shared/useApi";
import { Permissions } from "@/providers/user_context";
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

// step status is the engine's own activity status, not the work catalog — its own small tone map (the work status
// drives the row chip above; this drives the per-step chip in the detail accordion)
const stepToneColor: Record<WorkflowStep["status"], ChipColor> = {
  scheduled: "default",
  running: "info",
  completed: "success",
  failed: "error",
  timedOut: "warning",
  canceled: "warning",
};

// the accordion renders steps as a parentId/child tree; today every step is top-level (parentId null), but a
// child-workflow step would nest under its parent here with no UI change.
interface StepNode {
  step: WorkflowStep;
  children: StepNode[];
}

function buildStepTree(steps: WorkflowStep[]): StepNode[] {
  const byParent = new Map<string | null, WorkflowStep[]>();
  for (const step of steps) {
    const siblings = byParent.get(step.parentId) ?? [];
    siblings.push(step);
    byParent.set(step.parentId, siblings);
  }
  const build = (parentId: string | null): StepNode[] =>
    (byParent.get(parentId) ?? []).map((step) => ({ step, children: build(step.id) }));
  return build(null);
}

const dash = (v: string | null): string => v ?? "—";

// renders an ISO timestamp as local date+time; guards legacy rows whose createdAt predates the field (undefined)
const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : "—");

// one step on a single flat row — no expand/collapse; every field shows inline. children nest with a left indent
// so a child-workflow step still reads as nested. canRerun gates the ✕ "remove row" action — disabled while the
// work is in-flight, since the engine refuses a reset on a live run.
function StepRow({
  node,
  depth,
  canRerun,
  onRerun,
  removingIds,
}: {
  node: StepNode;
  depth: number;
  canRerun: boolean;
  onRerun: (stepId: string) => void;
  removingIds: Set<string>;
}) {
  const { step, children } = node;
  // optimistic: this step (and every later one) is grayed while its rerun-cut is in flight, then the refetch
  // replaces the list — a failed rerun clears the set so the dimmed rows revert instead of vanishing
  const removing = removingIds.has(step.id);
  return (
    <Fragment>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        sx={{ pl: depth * 2, py: 0.5, borderBottom: 1, borderColor: "divider", opacity: removing ? 0.5 : 1 }}
      >
        <Chip label={step.status} color={stepToneColor[step.status]} size="small" />
        {/* the prompt (description) is the differentiator; activity type follows in muted text, failure detail in red */}
        <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap>{step.description ?? step.name}</Typography>
          {step.description && (
            <Typography variant="caption" color="text.secondary" noWrap>{step.name}</Typography>
          )}
          {/* the agent's final structured answer for the step (report_result payload) — shown when it has landed */}
          {step.response && <Typography variant="caption" color="text.secondary">{step.response}</Typography>}
          {step.detail && <Typography variant="caption" color="error" noWrap>{step.detail}</Typography>}
        </Stack>
        <Typography variant="caption" color="text.secondary">id {step.id}</Typography>
        <Typography variant="caption" color="text.secondary">{new Date(step.startedAt).toLocaleTimeString()}</Typography>
        <Tooltip title={canRerun ? "Remove this step and everything after, then rerun from here" : "Available once the work has stopped running"}>
          <span>
            <IconButton
              size="small"
              color="error"
              disabled={!canRerun || removing}
              onClick={() => {
                // destructive: discards later steps' progress and re-dispatches from here, so confirm first
                if (window.confirm("Remove this step and everything after it, and rerun from here?")) onRerun(step.id);
              }}
            >
              <ClearIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {children.map((child) => (
        <StepRow key={child.step.id} node={child} depth={depth + 1} canRerun={canRerun} onRerun={onRerun} removingIds={removingIds} />
      ))}
    </Fragment>
  );
}

export default function WorkflowPage() {
  // composite host liveness pinged once on page load: workflow-engine link + the separate agent service's /healthz
  const health = useHealth();
  const api = useWorksApi();
  const [works, setWorks] = useState<WorkRecord[]>([]);
  const [statusCodes, setStatusCodes] = useState<Map<string, StatusCode>>(new Map());
  const [workflowId, setWorkflowId] = useState(""); // the selected workflow type; defaults to the first catalog entry once loaded
  const [opened, setOpened] = useState<string | null>(null); // the workId currently focused, if any
  const [steps, setSteps] = useState<WorkflowStep[]>([]); // the opened work's reconstructed step history, from its GET
  const [stepsError, setStepsError] = useState<string | null>(null); // why the step read failed, if it did (vs truly-empty)
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set()); // steps optimistically grayed while a rerun-cut is in flight

  // load the status catalog once: labels, chip tone, and per-status action rules all come from the host lookup
  const statusQuery = useApiQuery(() => api.getStatusCodes(), [api]);
  useEffect(() => {
    if (statusQuery.data) setStatusCodes(new Map(statusQuery.data.map((c) => [c.status, c])));
    // a missing catalog degrades gracefully (rows fall back to raw status + no actions), but log so the break is visible
    if (statusQuery.error) console.error("[workflow] failed to load status catalog:", statusQuery.error);
  }, [statusQuery.data, statusQuery.error]);

  // load the workflow catalog once: the Start dropdown is sourced from the host (code-defined), not hardcoded
  const workflowsQuery = useApiQuery(() => api.getWorkflows(), [api]);
  const workflows = workflowsQuery.data ?? [];
  useEffect(() => {
    // default the selection to the first template so Start is immediately usable
    if (workflows.length > 0) setWorkflowId((prev) => prev || workflows[0].name);
    if (workflowsQuery.error) console.error("[workflow] failed to load workflow catalog:", workflowsQuery.error);
  }, [workflows, workflowsQuery.error]);

  // primary load: the opened work alone, else the whole list. keyed on `opened` so focusing a row refetches it.
  const worksQuery = useApiQuery(
    async () =>
      opened
        ? ({ kind: "one", ...(await api.getWork(opened)) } as const)
        : ({ kind: "list", works: await api.searchWorks() } as const),
    [opened, api],
  );
  useEffect(() => {
    const result = worksQuery.data;
    if (!result) return;
    if (result.kind === "list") setWorks(result.works);
    else {
      setWorks((prev) => prev.map((w) => (w.workId === result.work.workId ? result.work : w)));
      setSteps(result.steps);
      setStepsError(result.stepsError);
    }
  }, [worksQuery.data]);

  // row actions share one mutation handle: any in-flight write drives the same loading/error surface
  const action = useApiMutation(async (run: () => Promise<void>) => run());

  // Refresh button: re-probe readiness AND re-run the last search/get in one go
  const healthRefresh = health.refresh;
  const worksRefresh = worksQuery.refresh;
  const onRefresh = useCallback(
    (): Promise<void> => Promise.all([healthRefresh(), worksRefresh()]).then(() => undefined),
    [healthRefresh, worksRefresh],
  );

  const onStart = (): Promise<void | undefined> =>
    action.run(async () => {
      await api.createWork(workflowId);
      setOpened(null); // back to the list so the new work shows
      await worksRefresh();
    });

  // one-row mutators share the same fold: swap just the touched row, surface any error inline
  const replaceRow = (work: WorkRecord): void =>
    setWorks((prev) => prev.map((w) => (w.workId === work.workId ? work : w)));

  const onStop = (workId: string): Promise<void | undefined> =>
    action.run(async () => replaceRow(await api.stopWork(workId)));

  // per-row refresh: re-GET this work alone (the GET also kicks a Temporal reconcile for the next read)
  const onRefreshRow = (workId: string): Promise<void | undefined> =>
    action.run(async () => {
      const { work, steps: workSteps, stepsError: err } = await api.getWork(workId);
      replaceRow(work);
      setSteps(workSteps);
      setStepsError(err);
    });

  // rerun a work from a chosen step (engine Reset); re-read the work after so the row status and the truncated,
  // re-dispatched step history both reflect the new run
  const onRerunStep = (workId: string, stepId: string): Promise<void | undefined> =>
    action.run(async () => {
      // gray the chosen step and every later one up front (the cut is by step order), so the destructive
      // truncation is visible immediately; `finally` clears the set — a failed rerun reverts the dimming
      const cutFrom = steps.findIndex((s) => s.id === stepId);
      if (cutFrom >= 0) setRemovingIds(new Set(steps.slice(cutFrom).map((s) => s.id)));
      try {
        await api.rerunStep(workId, stepId);
        const { work, steps: workSteps, stepsError: err } = await api.getWork(workId);
        replaceRow(work);
        setSteps(workSteps);
        setStepsError(err);
      } finally {
        setRemovingIds(new Set());
      }
    });

  // first paint shows "Loading…" until the initial fetch settles; the button reflects only in-flight refetches
  const loading = worksQuery.loading || !worksQuery.initialized;
  const error = useMemo(() => {
    const e = worksQuery.error ?? action.error;
    return e ? String(e) : null;
  }, [worksQuery.error, action.error]);

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
        Your work units — fetched on load; no live stream. Per row: Stop a running one, rerun a stopped one from any step, or Refresh just that row.
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
              <TableCell>Work ID</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Temporal</TableCell>
              <TableCell>Workspace</TableCell>
              <TableCell>Agent session</TableCell>
              <TableCell>Created</TableCell>
              <TableCell>Updated</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {works.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
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
                const isOpen = opened === w.workId;
                const tree = buildStepTree(steps);
                // rerun follows the catalog's `continuable` flag — true for the recoverable terminals (`stopped`,
                // `failed`); a `completed` work is the clean end (done) and new/running refuse a live reset anyway
                const canRerun = code?.continuable ?? false;
                return (
                  <Fragment key={w.workId}>
                    <TableRow
                      selected={isOpen}
                      sx={{ "& > *": { borderBottom: isOpen ? "unset" : undefined } }}
                    >
                      <TableCell>{w.workId.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Tooltip title={w.step ?? ""} disableHoverListener={!w.step}>
                          <Chip
                            label={code?.label ?? w.status}
                            color={code ? toneColor[code.tone] : "default"}
                            size="small"
                          />
                        </Tooltip>
                      </TableCell>
                      <TableCell>{dash(w.temporalId)}</TableCell>
                      <TableCell>{dash(w.workspaceId)}</TableCell>
                      <TableCell>{dash(w.sessionId)}</TableCell>
                      <TableCell>{when(w.createdAt)}</TableCell>
                      <TableCell>{when(w.ts)}</TableCell>
                      <TableCell align="right">
                        <Tooltip title={isOpen ? "Hide steps" : "Show steps"}>
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpened(isOpen ? null : w.workId);
                            }}
                          >
                            {isOpen ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Stop">
                          <span>
                            <IconButton
                              size="small"
                              color="warning"
                              disabled={!stoppable}
                              onClick={(e) => {
                                e.stopPropagation();
                                void onStop(w.workId);
                              }}
                            >
                              <StopCircleIcon fontSize="small" />
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
                                void onRefreshRow(w.workId);
                              }}
                            >
                              <RefreshIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                    {/* step history of THIS work, inline under its row; unmountOnExit so collapsed rows render no accordion */}
                    <TableRow>
                      <TableCell colSpan={8} sx={{ py: 0, borderBottom: isOpen ? undefined : "none" }}>
                        <Collapse in={isOpen} timeout="auto" unmountOnExit>
                          <Stack spacing={1} sx={{ py: 2 }}>
                            <Typography variant="subtitle2">Steps</Typography>
                            {stepsError ? (
                              <Typography variant="body2" color="error">
                                Step history unavailable: {stepsError}
                              </Typography>
                            ) : tree.length === 0 ? (
                              <Typography variant="body2" color="text.secondary">
                                No steps recorded yet.
                              </Typography>
                            ) : (
                              tree.map((node) => (
                                <StepRow
                                  key={node.step.id}
                                  node={node}
                                  depth={0}
                                  canRerun={canRerun}
                                  onRerun={(stepId) => void onRerunStep(w.workId, stepId)}
                                  removingIds={removingIds}
                                />
                              ))
                            )}
                          </Stack>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
