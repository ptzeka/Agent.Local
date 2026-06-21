import { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import { useApplicationContext } from "../providers/application_context";
import type IPage from "./IPage";

// page contract — consumed by PageMenu + routeConfig so nav and routing derive from one source
export const Page: IPage = { pageName: "login", displayLabel: "Sign in" };

// LOCAL credential login: posts to the auth service's /account/login, which sets the encrypted httpOnly session
// cookie (Domain=.peritze.com so the host reads it cross-subdomain). No token ever touches JS — on success we
// hard-navigate so the host re-renders the SSR shell with the now-hydrated session. credentials:"include" lets
// the cross-origin auth response set the cookie.
export default function LoginPage() {
  const { basePath, $config } = useApplicationContext();
  const authorityUrl = $config.get().authentication.authorityUrl;
  const profileHref = `${basePath ? `/${basePath}` : ""}/profile`;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${authorityUrl}/account/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setError("Invalid credentials");
      return;
    }
    window.location.assign(profileHref);
  };

  return (
    <Stack spacing={3} alignItems="flex-start" sx={{ maxWidth: 420 }}>
      <Typography variant="h4">Sign in</Typography>
      <Card variant="outlined" sx={{ width: "100%" }}>
        <CardContent>
          <Stack component="form" spacing={2} onSubmit={submit}>
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              fullWidth
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained">
              Sign in
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
