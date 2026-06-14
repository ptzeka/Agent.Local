import { EventEmitter } from "node:events";

/**
 * Eventing — the one push primitive for the agent.
 *
 * Every event exists to carry a state change UP from a child producer to a
 * parent consumer (ultimately the UI). A node `EventEmitter` handles local
 * fan-out; `add` chains a child bus to this one so a child's emissions bubble
 * upward — `publish` at a leaf reaches that leaf's subscribers first, then each
 * ancestor's, in order. Replaces threading an `onEvent` callback down the call
 * chain: producers `publish`, consumers `subscribe`, parents `add` children.
 */

export interface EventMessage {
  type: string;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: EventMessage) => void;

// Single internal channel: subscribers receive every event and switch on `type`,
// so there is no per-name listener bookkeeping to keep in sync.
const CHANNEL = "event";

export class Eventing {
  private readonly emitter = new EventEmitter();
  private readonly channel: string;
  // Buses this one bubbles into. Held on the child (set via parent.add(child)),
  // so a child can fan out to several parents without any parent enumerating it.
  private readonly parents = new Set<Eventing>();

  constructor(channel?: string) {
    this.channel = channel || CHANNEL;
    // Fan-out width is the number of UI/forwarding subscribers, not a leak.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Subscribe to events on this bus (or bubbled up into it). With a `channel`
   * the handler fires only for that event type (the standard channelled idiom);
   * without one it catches every event and switches on `type` itself. Returns an
   * unsubscribe function. A throwing handler is isolated so one bad subscriber
   * can neither break the producer nor stop the bubble.
   */
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
        /* a throwing subscriber must not break the producer or the bubble */
      }
    };
    this.emitter.on(this.channel, safe);
    return () => {
      this.emitter.off(this.channel, safe);
    };
  }

  /** Producer side. Delivers locally, then bubbles to every ancestor. */
  publish(type: string, payload: Record<string, unknown> = {}): void {
    this.deliver({ type, payload });
  }

  /**
   * Chain a child bus under this one: anything the child publishes bubbles up
   * here (and onward to this bus's own parents). Returns a detach function.
   * The direction is parent.add(child) — `this` is the parent/consumer.
   */
  add(child: Eventing): () => void {
    child.parents.add(this);
    return () => {
      child.parents.delete(this);
    };
  }

  // Deliver to local subscribers first, then bubble. `seen` guards against
  // cycles and diamonds so an event reaches each bus at most once per publish.
  private deliver(event: EventMessage, seen: Set<Eventing> = new Set()): void {
    if (seen.has(this)) return;
    seen.add(this);
    this.emitter.emit(this.channel, event);
    for (const parent of this.parents) parent.deliver(event, seen);
  }
}
