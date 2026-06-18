// the wire form of a bus event when it crosses a process boundary (host <-> agent over HTTP today, gRPC
// later). The transport carries the SAME event taxonomy as the in-process bus; a receiver just republishes
// `payload` under `eventType` onto its local bus, so HTTP is a pure bridge and the swap point stays here.
export interface EventEnvelope {
  eventType: string;
  payload: unknown;
}
