import type { EventEnvelope } from "./event-envelope.js";

// the cross-process comms ports. A sender forwards a bus event to the peer; a receiver accepts a peer event
// and acts on it locally. Transport-neutral by design (HTTP today, gRPC later) — neither names a Router, so
// the express binding stays a thin adapter in each host that calls these.

// outbound: forward one event envelope to the peer. throws on transport failure so the caller (the bus
// subscription that drives it) can react — fail the step, retry, or log.
export interface ISender {
  send(envelope: EventEnvelope): Promise<void>;
}

// inbound: act on one event envelope from the peer. Ctx carries the request-scoped inputs a receiver needs
// beyond the envelope (e.g. the agent builds a runtime from it); a receiver that needs nothing leaves it void.
export interface IReceiver<Ctx = void> {
  receive(envelope: EventEnvelope, ctx: Ctx): Promise<void>;
}
