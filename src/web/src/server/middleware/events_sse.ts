import type { Request, Response } from "express";
import type { Eventing, EventMessage } from "@agent-local/common/eventing";

// bus -> browser bridge: each connected console subscribes to the host bus and receives every event
// as SSE; the browser (eventing_context) reconnects automatically on drop. This is the console's live
// data channel — the host's bus is the single source of workflow/agent activity (the sandbox's
// api_proxy has no analogue here: the host owns the API, the bus owns the live stream).
export function eventsSseMiddleware(bus: Eventing, signal: AbortSignal) {
  return (req: Request, res: Response): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");

    const send = (event: EventMessage): void => {
      const line = JSON.stringify({ type: event.type, payload: event.payload, ts: Date.now() });
      res.write(`data: ${line}\n\n`);
    };
    const unsubscribe = bus.subscribe(send);

    // keep-alive comment so proxies don't time the idle stream out
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
    const close = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on("close", close);
    signal.addEventListener("abort", close);
  };
}
