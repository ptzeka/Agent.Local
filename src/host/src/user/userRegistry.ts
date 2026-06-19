import { createHash } from "node:crypto";
import { type IdentityClaims } from "@agent-local/common";

// LOCAL DEV ONLY credential store: md5 is deliberately weak and the operators are hardcoded below. This
// exists so the JWT issuer has something to authenticate against before real IAM lands — never ship it.
export type UserIdentity = Omit<IdentityClaims, "sub"> & { userId: string };

interface UserEntry extends UserIdentity {
  passwordHash: string;
}

// gates GET /api/auth/accesstoken — only holders may read their current session's access key back over the API
export const ACCESS_TOKEN_PERMISSION = "auth.accesstoken";

// md5 of the password; the registry stores hashes, never the plaintext, even for these dev accounts
function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

// hardcoded operators — add more lines here; e.g. user/test below logs in as username "user", password "test"
const USERS: UserEntry[] = [
  {
    userId: "9999",
    userName: "peritze",
    firstName: "Local",
    lastName: "Operator",
    // the human operator drives the workflow UI/APIs; agent:trigger/host:callback are service scopes, not theirs
    permissions: ["workflow:read", "workflow:write", ACCESS_TOKEN_PERMISSION],
    passwordHash: md5("Password1"),
  },
  // the agent's client-credentials identity: it fetches a token from /api/auth/token and presents host:callback on /receive
  {
    userId: "8001",
    userName: "agentic-client-dev",
    firstName: "Agent",
    lastName: "Client",
    permissions: ["host:callback"],
    passwordHash: md5("AgentClient1"),
  },
  // the host's OWN dispatch identity: it fetches a token from /api/auth/token and presents agent:trigger to the agent
  {
    userId: "8002",
    userName: "host-dispatch-dev",
    firstName: "Host",
    lastName: "Dispatch",
    permissions: ["agent:trigger"],
    passwordHash: md5("HostDispatch1"),
  },
];

// resolves a username/password to an identity, or null when either is wrong; constant set, so a linear scan
export class UserRegistry {
  public verify(username: string, password: string): UserIdentity | null {
    const entry = USERS.find((u) => u.userName === username);
    if (!entry) return null;
    if (entry.passwordHash !== md5(password)) return null;
    const { passwordHash: _hash, ...identity } = entry;
    return identity;
  }
}
