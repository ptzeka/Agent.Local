import { createHash } from "node:crypto";
import type { IdentityClaims } from "@agent-local/common";

// LOCAL DEV ONLY credential store: md5 is deliberately weak and the operators are hardcoded below. This
// exists so the JWT issuer has something to authenticate against before real IAM lands — never ship it.
export type UserIdentity = Omit<IdentityClaims, "sub"> & { userId: string };

interface UserEntry extends UserIdentity {
  passwordHash: string;
}

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
    permissions: ["workflow"],
    passwordHash: md5("Passwrod1"),
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
