import { Suspense } from "react";
import {
  ApplicationContextProvider,
  ConsoleLogger,
  type IConfiguration,
} from "../providers/application_context";
import { UserContextProvider, type IUser } from "../providers/user_context";
import { NotificationContextProvider } from "../providers/notification_context";
import { EventingContextProvider } from "../providers/eventing_context";
import ErrorBoundary from "../components/shared/ErrorBoundary";
import AppStart from "../components/appstart";
import Layout from "../components/layout";
import RouteConfig from "../routes/routeConfig";
import type { ThemeName } from "../theme/theme";

// the data the server injects into window.WEBPACK_ENTRY_DATA and hands to Root for the first render
export interface Bootstrap {
  applicationContext: {
    config: IConfiguration;
    basePath?: string;
    isSSR?: boolean;
    title?: string;
    theme?: ThemeName;
  };
  userContext: {
    user?: IUser;
    accessToken?: string;
    permissions?: Record<string, boolean>;
  };
}

// the provider stack — identical on server (StaticRouter) and client (BrowserRouter); the router is
// supplied by the caller (entry.tsx / render.tsx). Suspense wraps the config use() in ApplicationContext.
export default function Root({ bootstrap }: { bootstrap: Bootstrap }) {
  return (
    <Suspense>
      <ApplicationContextProvider value={{ ...bootstrap.applicationContext, logger: ConsoleLogger }}>
        <UserContextProvider value={bootstrap.userContext}>
          <NotificationContextProvider>
            <EventingContextProvider>
              <ErrorBoundary logger={ConsoleLogger}>
                <AppStart>
                  <Layout>
                    <RouteConfig />
                  </Layout>
                </AppStart>
              </ErrorBoundary>
            </EventingContextProvider>
          </NotificationContextProvider>
        </UserContextProvider>
      </ApplicationContextProvider>
    </Suspense>
  );
}
