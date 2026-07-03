// stand-in for the ESM-only `jose` package, which ts-jest's CommonJS test runtime cannot load. It exists so
// modules whose import chain reaches @agent-local/common's jwt.ts (IdentityMiddleware and friends) parse under
// Jest; it reproduces NO crypto. Every operation rejects, so a test can only exercise the verification-FAILURE
// path — the positive path (a genuinely signed token passing) is covered live against the running auth service.
const fail = (op: string) => {
  throw new Error(`jose test stub: ${op} is not available under Jest (ESM-only package)`);
};

export class SignJWT {
  constructor(_payload?: unknown) {}
  setProtectedHeader(): this { return this; }
  setSubject(): this { return this; }
  setIssuedAt(): this { return this; }
  setIssuer(): this { return this; }
  setAudience(): this { return this; }
  setExpirationTime(): this { return this; }
  async sign(): Promise<string> { return fail("SignJWT.sign"); }
}

export class EncryptJWT extends SignJWT {
  async encrypt(): Promise<string> { return fail("EncryptJWT.encrypt"); }
}

export const jwtVerify = async (): Promise<never> => fail("jwtVerify");
export const jwtDecrypt = async (): Promise<never> => fail("jwtDecrypt");
export const importPKCS8 = async (): Promise<never> => fail("importPKCS8");
export const importSPKI = async (): Promise<never> => fail("importSPKI");
export const exportJWK = async (): Promise<never> => fail("exportJWK");
export const calculateJwkThumbprint = async (): Promise<never> => fail("calculateJwkThumbprint");
export const createRemoteJWKSet = (): (() => never) => () => fail("createRemoteJWKSet resolver");

export type JWK = Record<string, unknown>;
export type JWTVerifyGetKey = (...args: unknown[]) => unknown;
