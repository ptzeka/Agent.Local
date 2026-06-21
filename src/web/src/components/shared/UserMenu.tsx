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
// auth service's /account/me (which decrypts the session cookie server-side), read client-side only so it
// renders nothing on the server and first paint — keeping hydration in agreement — then fills in.
export default function UserMenu() {
  const { basePath, $config } = useApplicationContext();
  const authorityUrl = $config.get().authentication.authorityUrl;
  const prefix = basePath ? `/${basePath}` : "";
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    // best-effort: if auth is unreachable we stay logged-out ("Sign in") rather than hiding the menu
    void fetch(`${authorityUrl}/account/me`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((data) => { if (!cancelled) setMe(data); })
      .catch(() => { if (!cancelled) setMe(null); });
    return () => {
      cancelled = true;
    };
  }, [authorityUrl]);

  const signOut = async (): Promise<void> => {
    await fetch(`${authorityUrl}/account/logout`, { method: "POST", credentials: "include" });
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
