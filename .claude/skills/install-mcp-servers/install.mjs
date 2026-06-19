#!/usr/bin/env node
// Installs this repo's MCP servers (from <repo>/mcp.json) into the user's
// global Claude (~/.claude.json) and Cursor (~/.cursor/mcp.json) configs.
//
// The repo's mcp.json is the source of truth. Absolute paths to dist/server.js
// are rebased onto THIS checkout's location, so the skill is portable across
// machines/clones. Existing unrelated entries are preserved; named entries are
// upserted (overwritten).
//
// Usage:
//   node install.mjs [--target claude|cursor|all] [--dry-run]
//
// Defaults: --target all.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// .claude/skills/install-mcp-servers -> repo root is three levels up.
const repoRoot = resolve(__dirname, "..", "..", "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetArg = (() => {
  const i = args.indexOf("--target");
  return i >= 0 ? args[i + 1] : "all";
})();
const targets =
  targetArg === "all" ? ["claude", "cursor"] : [targetArg];

const sourcePath = join(repoRoot, "mcp.json");
if (!existsSync(sourcePath)) {
  console.error(`Source mcp.json not found at ${sourcePath}`);
  process.exit(1);
}
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const sourceServers = source.mcpServers ?? {};

// Rebase any absolute path that points inside a repo checkout (".../src/...")
// onto this checkout's root, so a fresh clone elsewhere still works.
function rebase(value) {
  if (typeof value !== "string") return value;
  const idx = value.indexOf("/src/");
  if (idx >= 0 && value.startsWith("/")) {
    return join(repoRoot, value.slice(idx + 1));
  }
  return value;
}

function rebaseServer(def) {
  const out = JSON.parse(JSON.stringify(def));
  if (Array.isArray(out.args)) out.args = out.args.map(rebase);
  if (out.cwd) out.cwd = rebase(out.cwd);
  return out;
}

const servers = Object.fromEntries(
  Object.entries(sourceServers).map(([name, def]) => [name, rebaseServer(def)])
);

// Warn about unbuilt servers (don't block — user may build afterwards).
for (const [name, def] of Object.entries(servers)) {
  const entry = Array.isArray(def.args) ? def.args.find((a) => a.endsWith("server.js")) : null;
  if (entry && !existsSync(entry)) {
    console.warn(`  ! ${name}: ${entry} not built yet. Build it before use.`);
  }
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function upsert(path) {
  const config = loadJson(path);
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  const changed = [];
  for (const [name, def] of Object.entries(servers)) {
    const existed = name in config.mcpServers;
    config.mcpServers[name] = def;
    changed.push(`${existed ? "updated" : "added"} ${name}`);
  }
  if (dryRun) {
    console.log(`  [dry-run] would write ${path}: ${changed.join(", ")}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`  ${path}: ${changed.join(", ")}`);
}

const paths = {
  claude: join(homedir(), ".claude.json"),
  cursor: join(homedir(), ".cursor", "mcp.json"),
};

console.log(`Source: ${sourcePath}`);
console.log(`Servers: ${Object.keys(servers).join(", ")}`);
console.log(`Repo root: ${repoRoot}\n`);

for (const t of targets) {
  if (!paths[t]) {
    console.error(`Unknown target "${t}" (use claude, cursor, or all).`);
    process.exit(1);
  }
  console.log(`Target ${t}:`);
  upsert(paths[t]);
}
