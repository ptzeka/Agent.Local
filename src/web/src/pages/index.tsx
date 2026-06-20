import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import { useApplicationContext } from "../providers/application_context";
import { useUserContext } from "../providers/user_context";
import { useMiniStore } from "../components/shared/miniStore";
import type IPage from "./IPage";

// page contract — consumed by PageMenu + routeConfig so nav and routing derive from one source
export const Page: IPage = { pageName: "home", displayLabel: "Overview" };

export default function IndexPage() {
  const { title, $config } = useApplicationContext();
  const { $user } = useUserContext();
  const [config] = useMiniStore($config);
  const [user] = useMiniStore($user);

  return (
    <Stack spacing={3}>
      <Typography variant="h4">{title}</Typography>
      <Typography variant="body1" color="text.secondary">
        The application console for Agent.Local — Temporal workflows, agents, and the event mesh,
        streamed server-side via the co-hosted express host.
      </Typography>
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip label={`env: ${config.environment.name || "local"}`} />
            <Chip label={`app: ${config.environment.applicationName}`} />
            <Chip label={`user: ${user.userName}`} color="primary" variant="outlined" />
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
