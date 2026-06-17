import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { miniStore, type IMiniStore } from "../components/shared/miniStore";
import { useApplicationContext } from "./application_context";

// one delivered bus event as seen by the browser; mirrors the host's workflow.*/agent.* taxonomy.
export interface IBusEvent {
  type: string;
  payload: unknown;
  ts: number;
}

export interface IEventingContext {
  // append-only rolling log of events received over SSE; read with useMiniStore($events)
  $events: IMiniStore<IBusEvent[]>;
  // true once the EventSource is open (client only; always false during SSR)
  $connected: IMiniStore<boolean>;
}

const DEFAULT_VALUE: IEventingContext = {
  $events: miniStore.create<IBusEvent[]>({ current: [] }),
  $connected: miniStore.create<boolean>({ current: false }),
};

const EventingContext = createContext<IEventingContext>(DEFAULT_VALUE);

const MAX_EVENTS = 500;

export const EventingContextProvider = ({
  children,
}: {
  value?: unknown;
  children: React.ReactNode;
}): React.ReactElement => {
  const { logger } = useApplicationContext();
  const eventsRef = useRef<IBusEvent[]>([]);
  const connectedRef = useRef<boolean>(false);
  const ctx = useMemo<IEventingContext>(
    () => ({ $events: miniStore.create(eventsRef), $connected: miniStore.create(connectedRef) }),
    [],
  );

  // client-only: subscribe to the host bus via the mount's SSE endpoint. SSR never opens a socket.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const source = new EventSource("/events");
    source.onopen = () => ctx.$connected.set(true);
    source.onerror = () => ctx.$connected.set(false);
    source.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as IBusEvent;
        // new array reference so the Object.is guard fires and subscribers re-render
        ctx.$events.set([...ctx.$events.get(), evt].slice(-MAX_EVENTS));
      } catch (err) {
        logger.error("Bad SSE payload", err);
      }
    };
    return () => source.close();
  }, [ctx, logger]);

  return <EventingContext.Provider value={ctx}>{children}</EventingContext.Provider>;
};

export const useEventingContext = () => useContext(EventingContext);
