import { hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import Root from "./Root";
import { defaultBootstrap } from "../bootstrap";

// hydrate the SSR-streamed markup; seed Root from the server-injected bootstrap so the first client
// render matches the server's (no hydration mismatch). Mount node id must match the SSR shell.
const bootstrap = window.WEBPACK_ENTRY_DATA ?? defaultBootstrap();

hydrateRoot(
  document.getElementById("app")!,
  <BrowserRouter>
    <Root bootstrap={bootstrap} />
  </BrowserRouter>,
);
