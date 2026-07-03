import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 120_000;

export interface CliAuthSettings {
  // the auth service's own origin — /connect/authorize and /connect/token both hang off it
  authorityUrl: string;
  tokenUrl: string;
  // public (secret-less) client_id registered auth-side under nativeClients; pins the /callback path a
  // redirect_uri must match so the ephemeral loopback port is the only thing the CLI is free to vary
  nativeClientId: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

function tokenCachePath(): string {
  const dir = path.join(os.homedir(), ".config", "agent-local");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cli-token.json");
}

// RFC 7636 PKCE pair: verifier never leaves this process; only its SHA-256 (the challenge) crosses the
// browser, so a code intercepted in transit (proxy log, shoulder-surfed URL) is useless without it.
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

export function loadCachedToken(): string | null {
  try {
    const cached = JSON.parse(fs.readFileSync(tokenCachePath(), "utf8")) as CachedToken;
    if (Date.now() < cached.expiresAtMs) return cached.token;
  } catch {
    // no cache yet, or unreadable/corrupt — treat as logged out
  }
  return null;
}

function decodeExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch {
    // fall through to the default below
  }
  return Date.now() + 60 * 60 * 1000;
}

function cacheToken(token: string): CachedToken {
  const cached: CachedToken = { token, expiresAtMs: decodeExpiryMs(token) };
  fs.writeFileSync(tokenCachePath(), JSON.stringify(cached), { mode: 0o600 });
  return cached;
}

// interactive login: opens the system browser at the auth service's self-hosted /connect/authorize page,
// waits for the loopback redirect, then exchanges the code for a bearer via PKCE (no client secret — this
// is a public/native client). Caches the token so subsequent CLI runs pick it up without logging in again.
export async function login(settings: CliAuthSettings): Promise<CachedToken> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");

  let knownRedirectUri = "";
  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const ok = returnedState === state && !!returnedCode;
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<html><body>${ok ? "Login complete — you can close this window." : "Login failed — you can close this window."}</body></html>`,
      );
      if (settled) return;
      settled = true;
      server.close();
      if (!ok) {
        reject(new Error("cli login: state mismatch or missing code on callback"));
        return;
      }
      resolve(returnedCode as string);
    });
    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error("cli login: timed out waiting for browser callback"));
    }, LOGIN_TIMEOUT_MS);
    server.on("close", () => clearTimeout(timer));

    // loopback literal only — the auth service's whitelist rejects anything else regardless
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      knownRedirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const authorizeUrl = new URL("/connect/authorize", settings.authorityUrl);
      authorizeUrl.searchParams.set("client_id", settings.nativeClientId);
      authorizeUrl.searchParams.set("redirect_uri", knownRedirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      process.stderr.write(`Opening browser to sign in. If it doesn't open, visit:\n${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });

  const res = await fetch(settings.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: knownRedirectUri,
      client_id: settings.nativeClientId,
    }),
  });
  if (!res.ok) throw new Error(`cli login: token exchange failed (${res.status})`);
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error("cli login: no token in exchange response");
  return cacheToken(token);
}
