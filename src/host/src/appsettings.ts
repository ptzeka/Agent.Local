import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "@agent-local/common";

// the host owns hosting, so it owns the single appsettings.json. It sits at the package root next to
// package.json; this module compiles into dist/, so "../appsettings.json" resolves it in any cwd.
// APPSETTINGS_PATH overrides for tests / non-default deploys.
function resolveSettingsPath(): string {
  if (process.env.APPSETTINGS_PATH) return path.resolve(process.env.APPSETTINGS_PATH);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "appsettings.json");
}

// loads and parses the one config file once at startup. Secrets are NOT read here — appsettings only
// names the env vars; each feature reads its own secret from process.env, keeping values out of this object.
export function loadAppSettings(): AppSettings {
  const file = resolveSettingsPath();
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as AppSettings;
}
