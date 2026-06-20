import type { ReactNode } from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import { useApplicationContext } from "../providers/application_context";
import { useNotificationContext } from "../providers/notification_context";
import { useMiniStore } from "./shared/miniStore";
import PageMenu from "./shared/PageMenu";
import UserMenu from "./shared/UserMenu";

// app chrome: title bar + page navigation + a global toast sink. Renders identically on server and
// client (the Snackbar is hidden until a toast is set), so hydration matches.
export default function Layout({ children }: { children: ReactNode }) {
  const { title } = useApplicationContext();
  const { $toast, setToastMessage } = useNotificationContext();
  const [toast] = useMiniStore($toast);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <AppBar position="static">
        <Toolbar sx={{ gap: 3 }}>
          <Typography variant="h6" component="div">
            {title}
          </Typography>
          <PageMenu />
          {/* spacer pushes the auth area to the far right, like the sandbox Header's userArea */}
          <Box sx={{ flexGrow: 1 }} />
          <UserMenu />
        </Toolbar>
      </AppBar>
      <Container maxWidth={false} sx={{ py: 4, flex: 1 }}>
        {children}
      </Container>
      <Snackbar
        open={toast.showToastMessage}
        autoHideDuration={5000}
        onClose={() => setToastMessage("", toast.toastMessageType)}
      >
        <Alert severity={toast.toastMessageType}>{toast.toastMessage}</Alert>
      </Snackbar>
    </Box>
  );
}
