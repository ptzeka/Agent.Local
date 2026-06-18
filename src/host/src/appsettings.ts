import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "@agent-local/common";

// the host owns its own (host-specific) config; appsettings.json sits beside this loader under src/server.
// anchor to the package root (the dir holding package.json) so the same source file resolves whether the
// process runs from src (tsx dev) or dist (built) — config stays editable without a rebuild.
function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("host: could not locate package.json above the appsettings loader");
    cursor = parent;
  }
}

function resolveSettingsPath(): string {
  if (process.env.APPSETTINGS_PATH) return path.resolve(process.env.APPSETTINGS_PATH);
  return path.join(findPackageRoot(), "src", "server", "appsettings.json");
}

// secrets are NOT read here — appsettings only names env vars; each feature reads its own from process.env.
export function loadAppSettings(): AppSettings {
  const raw = fs.readFileSync(resolveSettingsPath(), "utf8");
  return JSON.parse(raw) as AppSettings;
}
