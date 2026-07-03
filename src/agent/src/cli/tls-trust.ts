import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

// services launched via scripts/start.sh inherit NODE_EXTRA_CA_CERTS=<mkcert root>, but the CLI runs bare
// (npm run dev), where Node trusts neither the OS keychain nor mkcert — so HTTPS to the *.peritze.com dev
// proxy fails verification while the browser sails through. Splice the mkcert root into the default store;
// no-op when the env var already handled it at process start or no mkcert CA exists on this machine.
export function trustLocalDevCa(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) return;
  const pem = path.join(process.env.CAROOT ?? defaultCaRoot(), "rootCA.pem");
  if (!fs.existsSync(pem)) return;
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), fs.readFileSync(pem, "utf8")]);
}

// mkcert's per-platform CAROOT defaults, resolved here instead of shelling out to `mkcert -CAROOT`
function defaultCaRoot(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "mkcert");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? "", "mkcert");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "mkcert");
}
