import React, { createContext, useContext, useMemo, useRef } from "react";
import { miniStore, type IMiniStore } from "../components/shared/miniStore";

export type ToastType = "success" | "info" | "warning" | "error";

export interface IToastNotification {
  showToastMessage: boolean;
  toastMessage: string;
  toastMessageType: ToastType;
}

const DEFAULT_TOAST: IToastNotification = {
  showToastMessage: false,
  toastMessage: "",
  toastMessageType: "info",
};

export interface INotificationContext {
  setToastMessage(message: string, type: ToastType): void;
  // subscribable handle — read with useMiniStore($toast), never read the whole context for the value
  $toast: IMiniStore<IToastNotification>;
}

const DEFAULT_VALUE: INotificationContext = {
  setToastMessage() {},
  $toast: miniStore.create({ current: DEFAULT_TOAST }),
};

const NotificationContext = createContext<INotificationContext>(DEFAULT_VALUE);

export const NotificationContextProvider = ({
  children,
}: {
  value?: unknown;
  children: React.ReactNode;
}): React.ReactElement => {
  // value lives in a ref so re-renders don't reset it; the store handle is created once and stays stable
  const toastRef = useRef<IToastNotification>(DEFAULT_TOAST);
  const $toast = miniStore.create(toastRef);

  const contextValue = useMemo<INotificationContext>(
    () => ({
      $toast,
      setToastMessage: (message, type) =>
        $toast.set({ toastMessage: message, toastMessageType: type, showToastMessage: message.length > 0 }),
    }),
    [$toast],
  );

  return <NotificationContext.Provider value={contextValue}>{children}</NotificationContext.Provider>;
};

export const useNotificationContext = () => useContext(NotificationContext);
