import { useEffect, useState } from "react";
import { Link } from "react-router";
import Stack from "@mui/material/Stack";
import MuiLink from "@mui/material/Link";
import { useApplicationContext } from "../../providers/application_context";

// the identity the host exposes for the current session (access token stays in the httpOnly cookie)
interface Me {
  userName: string;
  firstName: string;
  lastName: string;
}

// right-aligned auth area in the app bar: small-text greeting + Sign in / Profile / Sign out. Driven by the
// host's /api/me (which decrypts the session cookie server-side), read client-side only so it renders nothing
// on the server and first paint — keeping hydration in agreement — then fills in.
export default function UserMenu() {
  const { basePath } = useApplicationContext();
  const prefix = basePath ? `/${basePath}` : "";
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/me")
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((data) => {
        if (cancelled) return;
        setMe(data);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  const signOut = async (): Promise<void> => {
    await fetch("/api/logout", { method: "POST" });
    window.location.assign(`${prefix}/login`);
  };

  // logged out: small "Sign in" link only
  if (!me) {
    return (
      <MuiLink
        component={Link}
        to={`${prefix}/login`}
        color="inherit"
        underline="hover"
        variant="body2"
      >
        Sign in
      </MuiLink>
    );
  }

  // logged in: "{firstName} {lastName}" then Sign out; the name links to the profile page (keeps it reachable)
  const name = `${me.firstName} ${me.lastName}`.trim() || me.userName;
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <MuiLink component={Link} to={`${prefix}/profile`} color="inherit" underline="hover" variant="body2">
        {name}
      </MuiLink>
      <MuiLink component="button" onClick={signOut} color="inherit" underline="hover" variant="body2">
        Sign out
      </MuiLink>
    </Stack>
  );
}
