import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the RS256 keypair the host signs JWTs with; publicPem is the half handed to other dependencies to verify
export interface KeyPair {
  privatePem: string;
  publicPem: string;
}

// the host's signing keys, newest first: index 0 mints new tokens, the rest stay published in the JWKS and
// accepted on verify so tokens signed before a rotation keep validating until they expire.
export type KeyRing = KeyPair[];

// at most two keys live at once: the active signer plus one retiring key whose tokens are still in flight
const MAX_KEYS = 2;

// load the key ring from disk, generating + persisting the primary keypair on first run so tokens survive
// restarts. A second key (private.1.pem/public.1.pem) is picked up only if an operator stages one for a
// rotation — never auto-generated. HOST_KEYS_DIR overrides the location.
export function loadOrCreateKeyRing(): KeyRing {
  const dir = resolveKeysDir();
  const ring: KeyRing = [];
  for (let i = 0; i < MAX_KEYS; i++) {
    const suffix = i === 0 ? "" : `.${i}`;
    const privPath = path.join(dir, `private${suffix}.pem`);
    const pubPath = path.join(dir, `public${suffix}.pem`);
    if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      ring.push({
        privatePem: fs.readFileSync(privPath, "utf8"),
        publicPem: fs.readFileSync(pubPath, "utf8"),
      });
    }
  }
  if (ring.length > 0) return ring;

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "private.pem"), privateKey, "utf8");
  fs.writeFileSync(path.join(dir, "public.pem"), publicKey, "utf8");
  return [{ privatePem: privateKey, publicPem: publicKey }];
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
