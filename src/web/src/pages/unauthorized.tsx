import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { Link } from "react-router";

// shown by AuthorizedRoute when the user lacks the required permission (or is logged out, once real
// auth replaces the stub). returnURL is preserved so a future sign-in flow can land back here.
export default function Unauthorized({ returnURL }: { returnURL?: string }) {
  return (
    <Stack spacing={2} alignItems="flex-start">
      <Typography variant="h4">Not authorized</Typography>
      <Typography color="text.secondary">
        You do not have permission to view this page{returnURL ? "." : "."}
      </Typography>
      <Button component={Link} to="/" variant="contained">
        Back to overview
      </Button>
    </Stack>
  );
}
