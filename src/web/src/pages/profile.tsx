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
import { getStoredToken, decodeToken, clearStoredToken, type TokenClaims } from "../components/shared/token";
import type IPage from "./IPage.ts";

// page contract — consumed by PageMenu + routeConfig so nav and routing derive from one source
export const Page: IPage = { pageName: "profile", displayLabel: "Profile" };

// shows the identity carried INSIDE the stored JWT (firstName/lastName/permissions). Token read/decode is
// client-only, so it runs in an effect after hydration — on the server and first paint there is no token.
export default function ProfilePage() {
  const { basePath } = useApplicationContext();
  const loginHref = `${basePath ? `/${basePath}` : ""}/login`;
  const [claims, setClaims] = useState<TokenClaims | null>(null);
  const [loaded, setLoaded] = useState(false);

  const readToken = (): void => {
    const token = getStoredToken();
    setClaims(token ? decodeToken(token) : null);
    setLoaded(true);
  };

  useEffect(readToken, []);

  const signOut = (): void => {
    clearStoredToken();
    readToken();
  };

  if (!loaded) return null;

  if (!claims) {
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

  const expired = claims.exp !== undefined && claims.exp * 1000 < Date.now();

  return (
    <Stack spacing={3} sx={{ maxWidth: 480 }}>
      <Typography variant="h4">Profile</Typography>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Field label="Name" value={`${claims.firstName} ${claims.lastName}`.trim() || "—"} />
            <Field label="Username" value={claims.userName || "—"} />
            <Field label="User ID" value={claims.sub || "—"} />
            <div>
              <Typography variant="caption" color="text.secondary">
                Permissions
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
                {claims.permissions.length === 0 ? (
                  <Typography variant="body2">—</Typography>
                ) : (
                  claims.permissions.map((p) => <Chip key={p} label={p} size="small" />)
                )}
              </Stack>
            </div>
            <Divider />
            <Field
              label="Expires"
              value={claims.exp ? new Date(claims.exp * 1000).toLocaleString() : "—"}
            />
            {expired && <Alert severity="warning">This token has expired — sign in again.</Alert>}
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
