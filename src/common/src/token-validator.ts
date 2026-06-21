import { verifyIdentity, type JwtKeyResolver, type IdentityClaims } from "./jwt.js";

// the verify context a Validator is built with: how to resolve the signing key (a JWKS or local resolver) and
// the issuer/audience the token must carry. reusable — one Validator validates every request against these.
export interface ValidatorAuth {
  getKey: JwtKeyResolver;
  issuer?: string;
  audience?: string;
}

// the two failure modes a caller must tell apart: 401 = the token is absent or doesn't verify (sig/issuer/exp);
// 403 = it verified but lacks a required permission. ok carries the verified claims so the caller skips re-verify.
export type ValidationResult =
  | { ok: true; claims: IdentityClaims }
  | { ok: false; status: 401 | 403; error: string };

// verifies a presented bearer and checks its permissions in one call. issuer + expiration are enforced by jose
// inside verifyIdentity (the issuer option, and exp automatically); this adds the permission ("roles") gate and
// the 401-vs-403 split a verified-but-unauthorized token needs. Returns a result, never throws, so middleware
// branches on .ok instead of try/catch.
export class Validator {
  constructor(private readonly auth: ValidatorAuth) {}

  // token: the presented bearer (null when none was sent). permissions: every permission the token MUST carry —
  // an empty list checks only that the token is valid. Missing any required permission is a 403, not a 401.
  async validate(token: string | null, permissions: string[] = []): Promise<ValidationResult> {
    if (!token) return { ok: false, status: 401, error: "no token" };
    let claims: IdentityClaims;
    try {
      claims = await verifyIdentity(this.auth.getKey, token, { issuer: this.auth.issuer, audience: this.auth.audience });
    } catch (err) {
      return { ok: false, status: 401, error: String(err) };
    }
    const missing = permissions.filter((permission) => !claims.permissions.includes(permission));
    if (missing.length > 0) return { ok: false, status: 403, error: `missing permissions: ${missing.join(", ")}` };
    return { ok: true, claims };
  }
}
