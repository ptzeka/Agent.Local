import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import { useUserContext } from "../../providers/user_context";
import { useApplicationContext } from "../../providers/application_context";
import type IPage from "../../pages/IPage";
import { Page as IndexPage } from "../../pages/index";
import { Page as WorkflowPage } from "../../pages/workflow";

interface IPageEntry extends IPage {
  to: string;
}

// navigation derives from each page's exported `Page` constant + permission guard (sandbox convention):
// add a page to the menu by importing its Page export and pushing a permission-checked entry here.
export default function PageMenu() {
  const { basePath } = useApplicationContext();
  const { hasPermission } = useUserContext();
  const [pages, setPages] = useState<IPageEntry[]>([]);
  const location = useLocation();

  useEffect(() => {
    const prefix = basePath ? `/${basePath}` : "";
    const entries: IPageEntry[] = [{ ...IndexPage, to: `${prefix}/` }];
    if (!WorkflowPage.permission || hasPermission(WorkflowPage.permission)) {
      entries.push({ ...WorkflowPage, to: `${prefix}/${WorkflowPage.pageName.toLowerCase()}` });
    }
    setPages(entries);
  }, [basePath, hasPermission]);

  // match the longest registered path so /workflow doesn't fall back to the index tab
  const active =
    pages
      .map((p) => p.to)
      .filter((to) => location.pathname === to || (to !== "/" && location.pathname.startsWith(to)))
      .sort((a, b) => b.length - a.length)[0] ?? false;

  return (
    <Tabs value={active} textColor="inherit" indicatorColor="secondary">
      {pages.map((p) => (
        <Tab key={p.to} value={p.to} label={p.displayLabel} component={Link} to={p.to} />
      ))}
    </Tabs>
  );
}
