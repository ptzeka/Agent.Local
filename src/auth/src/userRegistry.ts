import { randomBytes, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from "node:crypto";
import { type IdentityClaims } from "@agent-local/common";

// async scrypt: keeps the KDF (deliberately CPU-heavy at N=2^17) off the event loop so verify never blocks
function scrypt(value: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(value, salt, keylen, options, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
  });
}

// LOCAL DEV ONLY credential store: the operators are hardcoded below so the JWT issuer
// has something to authenticate against before real IAM lands — never ship the accounts.
export type UserIdentity = Omit<IdentityClaims, "sub"> & { userId: string };

interface UserEntry extends UserIdentity {
  passwordHash: string;
}

interface UserSeed extends UserIdentity {
  password: string;
}

// OWASP-recommended scrypt cost: N=2^17 is the current minimum; maxmem must clear 128*N*r bytes
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

// scrypt with a per-entry random salt (OWASP-recommended for at-rest passwords); the registry
// stores only "salt:hash" hex, never the plaintext, even for these dev accounts
async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(value, salt, 64, SCRYPT)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPassword(value: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scrypt(value, Buffer.from(saltHex, "hex"), expected.length, SCRYPT)) as Buffer;
  // timing-safe equal guards the verify path against comparison-timing leaks
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// hardcoded operators — add more lines here; e.g. user/test below logs in as username "user", password "test"
const USERS: UserSeed[] = [
  {
    userId: "9999",
    userName: "peritze",
    firstName: "Local",
    lastName: "Operator",
    // the human operator drives the workflow UI/APIs; agent:trigger/host:callback are service scopes, not theirs
    permissions: ["workflow:read", "workflow:write", "auth.accesstoken"],
    password: "Password1",
  },
  // the agent's client-credentials identity: it fetches a token from /connect/token and presents host:callback on /receive
  {
    userId: "8001",
    userName: "agentic-client-dev",
    firstName: "Agent",
    lastName: "Client",
    permissions: ["host:callback"],
    password: "AgentClient1",
  },
  // the host's OWN dispatch identity: it fetches a token from /connect/token and presents agent:trigger to the agent
  {
    userId: "8002",
    userName: "host-dispatch-dev",
    firstName: "Host",
    lastName: "Dispatch",
    permissions: ["agent:trigger"],
    password: "HostDispatch1",
  },
];

// resolves a username/password to an identity, or null when either is wrong; constant set, so a linear scan
export class UserRegistry {
  // hashing is async now, so the seed can't be hashed at module load; hash once on first verify and memoize
  private entries?: Promise<UserEntry[]>;

  private load(): Promise<UserEntry[]> {
    this.entries ??= Promise.all(
      USERS.map(async ({ password, ...identity }) => ({ ...identity, passwordHash: await hashPassword(password) })),
    );
    return this.entries;
  }

  public async verify(username: string, password: string): Promise<UserIdentity | null> {
    const entries = await this.load();
    const entry = entries.find((u) => u.userName === username);
    if (!entry) return null;
    if (!(await verifyPassword(password, entry.passwordHash))) return null;
    const { passwordHash: _hash, ...identity } = entry;
    return identity;
  }
}
