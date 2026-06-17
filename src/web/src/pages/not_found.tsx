import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <Stack spacing={2} alignItems="flex-start">
      <Typography variant="h4">404 — Not found</Typography>
      <Typography color="text.secondary">That page does not exist.</Typography>
      <Button component={Link} to="/" variant="contained">
        Back to overview
      </Button>
    </Stack>
  );
}
