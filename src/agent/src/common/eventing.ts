import { EventEmitter } from "node:events";

// carries state changes UP from a child producer to a parent consumer, replacing a threaded onEvent callback:
// producers publish, consumers subscribe, parents add children so a leaf's events bubble through every ancestor
export interface EventMessage {
  type: string;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: EventMessage) => void;

// one channel: subscribers get every event and switch on `type`, so there's no per-name listener bookkeeping
const CHANNEL = "event";

export class Eventing {
  private readonly emitter = new EventEmitter();
  private readonly channel: string;
  // held on the child (set via parent.add(child)) so a child can fan out to several parents, none enumerating it
  private readonly parents = new Set<Eventing>();

  constructor(channel?: string) {
    this.channel = channel || CHANNEL;
    // unlimited: fan-out width is the number of UI/forwarding subscribers, not a leak
    this.emitter.setMaxListeners(0);
  }

  // optional channel narrows the handler to one event type; otherwise it catches all and switches on type
  subscribe(handler: EventHandler): () => void;
  subscribe(channel: string, handler: EventHandler): () => void;
  subscribe(channelOrHandler: string | EventHandler, maybeHandler?: EventHandler): () => void {
    const channel = typeof channelOrHandler === "string" ? channelOrHandler : undefined;
    const handler = typeof channelOrHandler === "string" ? maybeHandler! : channelOrHandler;
    const safe: EventHandler = (event) => {
      if (channel !== undefined && event.type !== channel) return;
      try {
        handler(event);
      } catch {
        // a throwing subscriber must not break the producer or the bubble
      }
    };
    this.emitter.on(this.channel, safe);
    return () => {
      this.emitter.off(this.channel, safe);
    };
  }

  // delivers locally, then bubbles to every ancestor
  publish(type: string, payload: Record<string, unknown> = {}): void {
    this.deliver({ type, payload });
  }

  // direction is parent.add(child): `this` is the consumer; returns a detach function
  add(child: Eventing): () => void {
    child.parents.add(this);
    return () => {
      child.parents.delete(this);
    };
  }

  // `seen` guards cycles and diamonds so an event reaches each bus at most once per publish
  private deliver(event: EventMessage, seen: Set<Eventing> = new Set()): void {
    if (seen.has(this)) return;
    seen.add(this);
    this.emitter.emit(this.channel, event);
    for (const parent of this.parents) parent.deliver(event, seen);
  }
}
