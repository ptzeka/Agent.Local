import React, { createContext, useContext, useMemo, useRef } from "react";
import { miniStore, type IMiniStore } from "../components/shared/miniStore";
import { useApplicationContext } from "./application_context";

export interface IUser {
  userId: string;
  userName: string;
  firstName: string;
  lastName: string;
}

/**
 * Permission keys used across the app. Always import from here — never hardcode strings in routes
 * or components. Pass a value to AuthorizedRoute's `permission` prop or hasPermission().
 */
export const Permissions = {
  WorkflowRead: "workflow:read",
  WorkflowWrite: "workflow:write",
};

/**
 * Public contract of UserContext — identical in shape to the sandbox's oidc-client-ts provider so
 * real PKCE auth drops in behind it later. Today it is a STUB: identity + permissions are placeholder
 * values seeded from the bootstrap (server) or defaults, and resolve as logged-in immediately.
 */
export interface IUserContextType {
  $user: IMiniStore<IUser>;
  $accessToken: IMiniStore<string>;
  $initialized: IMiniStore<boolean>;
  $hasPermissions: IMiniStore<boolean>;
  $isLoggedIn: IMiniStore<boolean>;
  hasPermission: (permission: string) => boolean;
  signIn(returnUrl?: string): Promise<void>;
  signOut(): void;
}

const STUB_USER: IUser = {
  userId: "local",
  userName: "local@agent.local",
  firstName: "Local",
  lastName: "Operator",
};

// stub default used only when the bootstrap carries no permissions map (standalone/dev): grant the workflow
// scopes so the guarded route is reachable. The host-mounted path always seeds the REAL map (see ssr_render).
const STUB_PERMISSIONS: Record<string, boolean> = {
  [Permissions.WorkflowRead]: true,
  [Permissions.WorkflowWrite]: true,
};

const DEFAULT_VALUE: IUserContextType = {
  $user: miniStore.create<IUser>({ current: STUB_USER }),
  $accessToken: miniStore.create<string>({ current: "AccessTokenHidden" }),
  $initialized: miniStore.create<boolean>({ current: true }),
  $hasPermissions: miniStore.create<boolean>({ current: true }),
  $isLoggedIn: miniStore.create<boolean>({ current: true }),
  hasPermission: () => true,
  signIn: () => Promise.resolve(),
  signOut: () => {},
};

const UserContext = createContext<IUserContextType>(DEFAULT_VALUE);

export const UserContextProvider = ({
  value,
  children,
}: {
  value?: { user?: IUser; accessToken?: string; permissions?: Record<string, boolean> };
  children: React.ReactNode;
}): React.ReactElement => {
  const { logger } = useApplicationContext();
  const user = value?.user ?? STUB_USER;
  const permissions = value?.permissions ?? STUB_PERMISSIONS;

  // stores created once from the seeded values; stable across renders via refs. login state is REAL: a server
  // bootstrap without a resolved user (no/expired session) renders signed-out so guarded routes send to login.
  // permRef/initRef stay true — they are readiness gates (permissions resolved), not the authz check itself.
  const userRef = useRef<IUser>(user);
  const tokenRef = useRef<string>(value?.accessToken ?? "AccessTokenHidden");
  const initRef = useRef<boolean>(true);
  const permRef = useRef<boolean>(true);
  const loginRef = useRef<boolean>(!!value?.user);

  const ctx = useMemo<IUserContextType>(
    () => ({
      $user: miniStore.create<IUser>(userRef),
      $accessToken: miniStore.create<string>(tokenRef),
      $initialized: miniStore.create<boolean>(initRef),
      $hasPermissions: miniStore.create<boolean>(permRef),
      $isLoggedIn: miniStore.create<boolean>(loginRef),
      hasPermission: (k: string) => permissions[k] === true,
      // STUB seams — wire oidc-client-ts here later, preserving this signature
      signIn: () => Promise.resolve(),
      signOut: () => {},
    }),
    [permissions],
  );

  logger.debug("UserContext initialized (stub)", { user: user.userName });
  return <UserContext.Provider value={ctx}>{children}</UserContext.Provider>;
};

export const useUserContext = () => useContext(UserContext);
