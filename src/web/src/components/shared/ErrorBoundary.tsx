import React from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import type { ILogger } from "../../providers/application_context";

interface Props {
  logger: ILogger;
  children: React.ReactNode;
}
interface State {
  error: Error | null;
}

// top-of-tree boundary: catches render-time throws so a failed page never blanks the whole console
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.logger.error("Unhandled render error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <Alert severity="error" sx={{ m: 4 }}>
          <AlertTitle>Something went wrong</AlertTitle>
          {this.state.error.message}
        </Alert>
      );
    }
    return this.props.children;
  }
}
