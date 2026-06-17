import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";

// app-wide loading gate fallback, rendered until AppStart's readiness flags are all true
export default function Loading() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <CircularProgress />
    </Box>
  );
}
