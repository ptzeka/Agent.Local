import { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import type IPage from "./IPage.ts";

// page contract — consumed by PageMenu + routeConfig so nav and routing derive from one source
export const Page: IPage = { pageName: "login", displayLabel: "Sign in" };

// LOCAL credential login: posts to the host's /api/login and stashes the returned JWT. Wiring this token
// into UserContext (the verify/consume side) is the deferred step; this page only obtains the token.
export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setError("Invalid credentials");
      return;
    }
    const data = (await res.json()) as { token: string };
    localStorage.setItem("agent.local.jwt", data.token);
    setToken(data.token);
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
            {token && <Alert severity="success">Signed in — token stored.</Alert>}
            <Button type="submit" variant="contained">
              Sign in
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
