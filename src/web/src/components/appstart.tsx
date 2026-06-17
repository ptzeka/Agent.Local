import React, { Suspense } from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { useApplicationContext } from "../providers/application_context";
import { useUserContext } from "../providers/user_context";
import { useMiniStore } from "./shared/miniStore";
import { resolveTheme } from "../theme/theme";
import Loading from "./shared/Loading";

// readiness gate: render the app only once config + user + permissions are all settled. Unlike the
// sandbox (CSS-token themes), we mount the MUI ThemeProvider here from the active theme name.
const Suspended = ({ children }: { children: React.ReactNode }) => {
  const { $theme, $config, logger } = useApplicationContext();
  const { $initialized, $hasPermissions } = useUserContext();
  const [themeName] = useMiniStore($theme);
  const [config] = useMiniStore($config);
  const [initialized] = useMiniStore($initialized);
  const [hasPermissions] = useMiniStore($hasPermissions);

  logger.debug("AppStart", { theme: themeName, config: config?.initialized, initialized, hasPermissions });

  const ready = themeName && config?.initialized && initialized && hasPermissions;
  return (
    <ThemeProvider theme={resolveTheme(themeName)}>
      <CssBaseline />
      {ready ? children : <Loading />}
    </ThemeProvider>
  );
};

export default function AppStart({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<Loading />}>
      <Suspended>{children}</Suspended>
    </Suspense>
  );
}
