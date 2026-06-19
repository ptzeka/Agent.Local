import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

// RS256 so the holder of the private key (the host) signs and any dependency holding only the PUBLIC key
// can verify without a shared secret — that asymmetry is the whole point of moving the public key around.
const ALG = "RS256";

// the identity the host puts inside the token and every consumer reads back out; mirrors the web's
// IRequestUserInfo so the verify side can attach it to a request context unchanged.
export interface IdentityClaims {
  sub: string;
  userName: string;
  firstName: string;
  lastName: string;
  permissions: string[];
}

export interface JwtOptions {
  issuer?: string;
  audience?: string;
  // token lifetime as a jose time string; short by default since these are local operator sessions
  expiresIn?: string;
}

// signs identity claims with the PKCS8 private PEM; the host is the only party that ever calls this
export async function signIdentity(
  privatePem: string,
  claims: IdentityClaims,
  options: JwtOptions = {},
): Promise<string> {
  const key = await importPKCS8(privatePem, ALG);
  let jwt = new SignJWT({
    userName: claims.userName,
    firstName: claims.firstName,
    lastName: claims.lastName,
    permissions: claims.permissions,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "8h");
  if (options.issuer) jwt = jwt.setIssuer(options.issuer);
  if (options.audience) jwt = jwt.setAudience(options.audience);
  return jwt.sign(key);
}

// verifies a token with the SPKI public PEM and returns the identity; this is the "consume" side any
// dependency runs once the host hands it the public key. Throws (jose) when signature/claims fail.
export async function verifyIdentity(
  publicPem: string,
  token: string,
  options: JwtOptions = {},
): Promise<IdentityClaims> {
  const key = await importSPKI(publicPem, ALG);
  const { payload } = await jwtVerify(token, key, {
    issuer: options.issuer,
    audience: options.audience,
  });
  return {
    sub: String(payload.sub),
    userName: String(payload.userName ?? ""),
    firstName: String(payload.firstName ?? ""),
    lastName: String(payload.lastName ?? ""),
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
  };
}
