import { Route, Routes, Outlet, useLocation } from "react-router";
import { useUserContext } from "../providers/user_context";
import { useApplicationContext } from "../providers/application_context";
import { useMiniStore } from "../components/shared/miniStore";
import IndexPage, { Page as Index } from "../pages/index";
import WorkflowPage, { Page as Workflow } from "../pages/workflow";
import LoginPage, { Page as Login } from "../pages/login";
import NotFound from "../pages/not_found";
import Unauthorized from "../pages/unauthorized";

// guards a route by login state + permission; renders Unauthorized instead of the protected Outlet
const AuthorizedRoute = ({ permission }: { permission: string }) => {
  const { logger } = useApplicationContext();
  const { hasPermission, $isLoggedIn } = useUserContext();
  const [isLoggedIn] = useMiniStore($isLoggedIn);
  const location = useLocation();
  const returnUrl = encodeURIComponent(location.pathname + location.search);
  logger.debug("AuthorizedRoute", { isLoggedIn, permission, granted: hasPermission(permission) });

  if (!isLoggedIn || !hasPermission(permission)) {
    return <Unauthorized returnURL={returnUrl} />;
  }
  return <Outlet />;
};

export default function RouteConfig() {
  const { basePath } = useApplicationContext();
  const prefix = basePath ? `/${basePath}` : "";

  return (
    <Routes>
      <Route path={`${prefix}/`} Component={IndexPage} />
      <Route path={`${prefix}/${Index.pageName.toLowerCase()}`} Component={IndexPage} />
      <Route path={`${prefix}/${Login.pageName.toLowerCase()}`} Component={LoginPage} />

      <Route element={<AuthorizedRoute permission={Workflow.permission!} />}>
        <Route path={`${prefix}/${Workflow.pageName.toLowerCase()}`} Component={WorkflowPage} />
      </Route>

      <Route path="*" Component={NotFound} />
    </Routes>
  );
}
