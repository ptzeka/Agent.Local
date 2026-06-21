import { useEffect, useState } from "react";
import { Link } from "react-router";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import { useApplicationContext } from "../providers/application_context.js";
import type IPage from "./IPage.ts";

// page contract — consumed by PageMenu + routeConfig so nav and routing derive from one source
export const Page: IPage = { pageName: "profile", displayLabel: "Profile" };

// the identity the host exposes for the current session; the access token stays inside the httpOnly cookie
interface Me {
  sub: string;
  userName: string;
  firstName: string;
  lastName: string;
  permissions: string[];
}

// shows the signed-in identity, read from the auth service's /account/me (which decrypts the session cookie
// server-side). 401 means no/expired session -> render the signed-out state. Runs in an effect since it is a
// network read; credentials:"include" sends the cross-origin session cookie to the auth service.
export default function ProfilePage() {
  const { basePath, $config } = useApplicationContext();
  const authorityUrl = $config.get().authentication.authorityUrl;
  const loginHref = `${basePath ? `/${basePath}` : ""}/login`;
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${authorityUrl}/account/me`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((data) => {
        if (cancelled) return;
        setMe(data);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authorityUrl]);

  const signOut = async (): Promise<void> => {
    await fetch(`${authorityUrl}/account/logout`, { method: "POST", credentials: "include" });
    window.location.assign(loginHref);
  };

  if (!loaded) return null;

  if (!me) {
    return (
      <Stack spacing={3} sx={{ maxWidth: 420 }}>
        <Typography variant="h4">Profile</Typography>
        <Alert severity="info">You are not signed in.</Alert>
        <Button component={Link} to={loginHref} variant="contained">
          Sign in
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 480 }}>
      <Typography variant="h4">Profile</Typography>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Field label="Name" value={`${me.firstName} ${me.lastName}`.trim() || "—"} />
            <Field label="Username" value={me.userName || "—"} />
            <Field label="User ID" value={me.sub || "—"} />
            <div>
              <Typography variant="caption" color="text.secondary">
                Permissions
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
                {me.permissions.length === 0 ? (
                  <Typography variant="body2">—</Typography>
                ) : (
                  me.permissions.map((p) => <Chip key={p} label={p} size="small" />)
                )}
              </Stack>
            </div>
            <Divider />
          </Stack>
        </CardContent>
      </Card>
      <Button onClick={signOut} variant="outlined" color="error" sx={{ alignSelf: "flex-start" }}>
        Sign out
      </Button>
    </Stack>
  );
}

// a labelled read-only value row
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body1">{value}</Typography>
    </div>
  );
}
