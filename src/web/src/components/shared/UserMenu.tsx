import { useEffect, useState } from "react";
import { Link } from "react-router";
import Stack from "@mui/material/Stack";
import MuiLink from "@mui/material/Link";
import { useApplicationContext } from "../../providers/application_context";
import {
  getStoredToken,
  decodeToken,
  clearStoredToken,
  AUTH_CHANGED_EVENT,
  type TokenClaims,
} from "./token";

// right-aligned auth area in the app bar, mirroring the sandbox Header's userArea: small-text greeting +
// a Sign in / Profile / Sign out link set. Driven by the stored JWT, read client-side only (SSR-safe), so
// it renders nothing on the server and first paint — keeping hydration in agreement — then fills in.
export default function UserMenu() {
  const { basePath } = useApplicationContext();
  const prefix = basePath ? `/${basePath}` : "";
  const [claims, setClaims] = useState<TokenClaims | null>(null);
  const [loaded, setLoaded] = useState(false);

  const read = (): void => {
    const token = getStoredToken();
    setClaims(token ? decodeToken(token) : null);
    setLoaded(true);
  };

  // read on mount, then refresh whenever the token changes — same-tab via AUTH_CHANGED_EVENT (login/logout
  // here), cross-tab via the native storage event — so the app bar reflects sign in/out without a reload
  useEffect(() => {
    read();
    window.addEventListener(AUTH_CHANGED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  if (!loaded) return null;

  const signOut = (): void => {
    clearStoredToken();
    read();
  };

  // logged out: small "Sign in" link only
  if (!claims) {
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

  // logged in: "{firstName} {lastName}" then Sign out, mirroring the sandbox Header's userArea. The name
  // links to the profile page (keeps it reachable) but reads as plain small text like the sandbox.
  const name = `${claims.firstName} ${claims.lastName}`.trim() || claims.userName;
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
