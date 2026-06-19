import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the RS256 keypair the host signs JWTs with; publicPem is the half handed to other dependencies to verify
export interface KeyPair {
  privatePem: string;
  publicPem: string;
}

// load the keypair from disk, generating + persisting it on first run so tokens survive restarts and the
// public key has a stable on-disk home other deps can read. HOST_KEYS_DIR overrides the location.
export function loadOrCreateKeyPair(): KeyPair {
  const dir = resolveKeysDir();
  const privPath = path.join(dir, "private.pem");
  const pubPath = path.join(dir, "public.pem");

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privatePem: fs.readFileSync(privPath, "utf8"),
      publicPem: fs.readFileSync(pubPath, "utf8"),
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privPath, privateKey, "utf8");
  fs.writeFileSync(pubPath, publicKey, "utf8");
  return { privatePem: privateKey, publicPem: publicKey };
}

function resolveKeysDir(): string {
  if (process.env.HOST_KEYS_DIR) return path.resolve(process.env.HOST_KEYS_DIR);
  return path.join(findPackageRoot(), "keys");
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, "package.json"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("host: could not locate package.json above the key loader");
    cursor = parent;
  }
}
