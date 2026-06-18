import express from "express";
import { Eventing } from "@agent-local/common/eventing";
import { mount } from "./mount.js";

// standalone dev/start host: only this entry may own an express app + bus; the co-hosted process
// calls mount(app, ctx) directly against its own app and ctx.bus (see mount.tsx)
function parsePort(): number {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("-p");
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  return Number(process.env.PORT) || 3000;
}

const app = express();
const controller = new AbortController();

mount(app, {
  bus: new Eventing(),
  logger: console,
  signal: controller.signal,
});

const port = parsePort();
const server = app.listen(port, () => console.log(`@agent-local/web listening on :${port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    controller.abort();
    server.close(() => process.exit(0));
  });
}
