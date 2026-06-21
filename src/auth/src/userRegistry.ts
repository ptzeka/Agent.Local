import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { type IdentityClaims } from "@agent-local/common";

// LOCAL DEV ONLY credential store: the operators are hardcoded below so the JWT issuer
// has something to authenticate against before real IAM lands — never ship the accounts.
export type UserIdentity = Omit<IdentityClaims, "sub"> & { userId: string };

interface UserEntry extends UserIdentity {
  passwordHash: string;
}

// OWASP-recommended scrypt cost: N=2^17 is the current minimum; maxmem must clear 128*N*r bytes
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

// scrypt with a per-entry random salt (OWASP-recommended for at-rest passwords); the registry
// stores only "salt:hash" hex, never the plaintext, even for these dev accounts
function hashPassword(value: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(value, salt, 64, SCRYPT).toString("hex")}`;
}

function verifyPassword(value: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = scryptSync(value, Buffer.from(saltHex, "hex"), expected.length, SCRYPT);
  // timing-safe equal guards the verify path against comparison-timing leaks
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// hardcoded operators — add more lines here; e.g. user/test below logs in as username "user", password "test"
const USERS: UserEntry[] = [
  {
    userId: "9999",
    userName: "peritze",
    firstName: "Local",
    lastName: "Operator",
    // the human operator drives the workflow UI/APIs; agent:trigger/host:callback are service scopes, not theirs
    permissions: ["workflow:read", "workflow:write", "auth.accesstoken"],
    passwordHash: hashPassword("Password1"),
  },
  // the agent's client-credentials identity: it fetches a token from /connect/token and presents host:callback on /receive
  {
    userId: "8001",
    userName: "agentic-client-dev",
    firstName: "Agent",
    lastName: "Client",
    permissions: ["host:callback"],
    passwordHash: hashPassword("AgentClient1"),
  },
  // the host's OWN dispatch identity: it fetches a token from /connect/token and presents agent:trigger to the agent
  {
    userId: "8002",
    userName: "host-dispatch-dev",
    firstName: "Host",
    lastName: "Dispatch",
    permissions: ["agent:trigger"],
    passwordHash: hashPassword("HostDispatch1"),
  },
];

// resolves a username/password to an identity, or null when either is wrong; constant set, so a linear scan
export class UserRegistry {
  public verify(username: string, password: string): UserIdentity | null {
    const entry = USERS.find((u) => u.userName === username);
    if (!entry) return null;
    if (!verifyPassword(password, entry.passwordHash)) return null;
    const { passwordHash: _hash, ...identity } = entry;
    return identity;
  }
}
