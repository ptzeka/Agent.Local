import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";
import { useEventingContext } from "../providers/eventing_context";
import { useMiniStore } from "../components/shared/miniStore";
import { Permissions } from "../providers/user_context";
import type IPage from "./IPage";

// guarded page — routeConfig wraps it in AuthorizedRoute(Permissions.Workflow)
export const Page: IPage = { pageName: "workflow", displayLabel: "Workflow", permission: Permissions.Workflow };

const WORKFLOW_PREFIX = "workflow.";
const AGENT_PREFIX = "agent.";

// pull processInstanceKey/jobKey out of the (loosely-typed) bus payload for the table columns
const field = (payload: unknown, key: string): string => {
  if (payload && typeof payload === "object" && key in payload) {
    return String((payload as Record<string, unknown>)[key] ?? "");
  }
  return "";
};

const chipColor = (type: string) => {
  if (type.endsWith(".completed")) return "success" as const;
  if (type.endsWith(".failed")) return "error" as const;
  if (type.startsWith(AGENT_PREFIX)) return "secondary" as const;
  return "info" as const;
};

export default function WorkflowPage() {
  const { $events, $connected } = useEventingContext();
  const [events] = useMiniStore($events);
  const [connected] = useMiniStore($connected);

  // newest first; only workflow/agent mesh events belong on this view
  const rows = events
    .filter((e) => e.type.startsWith(WORKFLOW_PREFIX) || e.type.startsWith(AGENT_PREFIX))
    .slice()
    .reverse();

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="h4">Workflows</Typography>
        <Chip
          label={connected ? "live" : "connecting…"}
          color={connected ? "success" : "default"}
          size="small"
        />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Live Camunda/agent events from the host bus (`workflow.*`, `agent.*`), newest first.
      </Typography>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Event</TableCell>
              <TableCell>Process</TableCell>
              <TableCell>Job</TableCell>
              <TableCell>Time</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    No workflow events yet. Start a process to see it here.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((e, i) => (
                <TableRow key={`${e.ts}-${i}`}>
                  <TableCell>
                    <Chip label={e.type} color={chipColor(e.type)} size="small" />
                  </TableCell>
                  <TableCell>{field(e.payload, "processInstanceKey")}</TableCell>
                  <TableCell>{field(e.payload, "jobKey")}</TableCell>
                  <TableCell>{new Date(e.ts).toLocaleTimeString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
