import { decodeJwt } from "jose";
import { basicAuthHeader } from "./jwt.js";
import { AccessTokenValidator, type ValidatorAuth } from "./access-token-validator.js";
import type { ILogger } from "./ilogger.js";

// RFC 8693 OAuth 2.0 Token Exchange grant: a subject_token under this grant yields an OBO (on-behalf-of) token.
// shared here (and re-imported by the host's token endpoint) so the wire constant has ONE definition.
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

// one client's credentials, registered into the store under its clientId. skewMs refreshes early so an
// in-flight call never carries a token that expires mid-request. validatorAuth, when set, verifies a freshly
// fetched token (sig/issuer/exp) before it is cached — see the note on Entry.validator.
export interface AccessTokenProviderConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  skewMs?: number;
  validatorAuth?: ValidatorAuth;
}

// one cached token + the wall-clock instant it must be refetched by (its exp minus the skew)
interface CacheSlot {
  token: string;
  expiresAtMs: number;
}

// per-client cache state: its own client-credentials slot plus a per-subject OBO map. each clientId owns one
// Entry so one store can hold many identities (host dispatch creds, agent result creds, ...) without sharing.
interface Entry {
  config: AccessTokenProviderConfig;
  own: CacheSlot | null;
  ownInflight: Promise<string | null> | null;
  obo: Map<string, CacheSlot>;
  oboInflight: Map<string, Promise<string | null>>;
  // when configured, a fetched token is verified before caching so one the issuer would reject is never
  // presented. null when no verify context is given — then the exp decode is the only validity gate.
  validator: AccessTokenValidator | null;
}

const DEFAULT_SKEW_MS = 30_000;

// an in-memory store of service bearers, keyed by clientId: register credentials once at startup, then
// getAccessTokenAsync(clientId) returns the cached token and refreshes only past expiry, so the dispatch/webhook
// hot paths stop minting (and discarding) a token per call. Held as a process singleton so the cache survives
// across requests — the request middleware passes a reference, it never rebuilds the store. Two grants share the
// fetch: plain client-credentials (the service's OWN token) and RFC 8693 token-exchange (an OBO token carrying
// this service as the `act` actor, on a subject's behalf). Validity is the `exp` claim alone — decode, no
// signature check — since the resource server re-verifies.
export class AccessTokenProvider {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly logger: ILogger) {}

  // idempotent registration: unchanged credentials (same secret + tokenUrl) keep the cached slots so a
  // re-register never flushes a still-valid token; a changed secret/url replaces the entry, since tokens minted
  // under the old credentials no longer apply. safe to call more than once (e.g. a settings hot-reload).
  register(config: AccessTokenProviderConfig): void {
    const validator = config.validatorAuth ? new AccessTokenValidator(config.validatorAuth) : null;
    const existing = this.entries.get(config.clientId);
    if (existing && existing.config.clientSecret === config.clientSecret && existing.config.tokenUrl === config.tokenUrl) {
      existing.config = config;
      existing.validator = validator;
      return;
    }
    this.entries.set(config.clientId, {
      config,
      validator,
      own: null,
      ownInflight: null,
      obo: new Map(),
      oboInflight: new Map(),
    });
  }

  // the cached client-credentials token for this clientId while it is still inside its lifetime; otherwise a
  // freshly fetched one. null when the fetch fails or returns nothing — callers treat that as "unauthenticated".
  async getAccessTokenAsync(clientId: string): Promise<string | null> {
    const entry = this.entryFor(clientId);
    if (entry.own && Date.now() < entry.own.expiresAtMs) return entry.own.token;
    if (!entry.ownInflight) {
      entry.ownInflight = this.fetchToken(entry, undefined)
        .then((token) => {
          entry.own = this.slotFor(entry, token);
          return token;
        })
        .finally(() => {
          entry.ownInflight = null;
        });
    }
    return entry.ownInflight;
  }

  // OBO (RFC 8693): exchange the subject's token for one whose top-level claims stay the subject's and whose
  // `act` names THIS clientId (its Basic creds are the actor). cached per subject so a burst for the same user
  // reuses one token; concurrent misses for that subject collapse onto a single exchange. null like the plain path.
  async getAccessTokenWithActorAsync(clientId: string, subjectToken: string): Promise<string | null> {
    const entry = this.entryFor(clientId);
    const cached = entry.obo.get(subjectToken);
    if (cached && Date.now() < cached.expiresAtMs) return cached.token;
    let inflight = entry.oboInflight.get(subjectToken);
    if (!inflight) {
      inflight = this.fetchToken(entry, subjectToken)
        .then((token) => {
          this.storeObo(entry, subjectToken, token);
          return token;
        })
        .finally(() => {
          entry.oboInflight.delete(subjectToken);
        });
      entry.oboInflight.set(subjectToken, inflight);
    }
    return inflight;
  }

  // resolve a registered entry or self-report: an unregistered clientId is a wiring bug, surfaced here by name
  // rather than as a silent null the caller would read as "unauthenticated".
  private entryFor(clientId: string): Entry {
    const entry = this.entries.get(clientId);
    if (!entry) throw new Error(`AccessTokenProvider: no credentials registered for clientId "${clientId}"`);
    return entry;
  }

  // one POST to /connect/token, form-encoded per RFC 6749: grant_type=client_credentials when subjectToken is
  // undefined, token-exchange (RFC 8693) when present. Basic auth is this entry's creds. null on a non-2xx, an
  // empty body, or a token the optional validator rejects.
  private async fetchToken(entry: Entry, subjectToken: string | undefined): Promise<string | null> {
    const { tokenUrl, clientId, clientSecret } = entry.config;
    const headers: Record<string, string> = {
      authorization: basicAuthHeader(clientId, clientSecret),
      "content-type": "application/x-www-form-urlencoded",
    };
    const body = new URLSearchParams(
      subjectToken
        ? { grant_type: TOKEN_EXCHANGE_GRANT, subject_token: subjectToken }
        : { grant_type: "client_credentials" },
    ).toString();
    const res = await fetch(tokenUrl, { method: "POST", headers, body });
    if (!res.ok) {
      this.logger.error?.(`[token] fetch ${tokenUrl} -> ${res.status}`);
      return null;
    }
    const token = ((await res.json()) as { access_token?: string }).access_token ?? null;
    if (token && entry.validator) {
      const result = await entry.validator.validate(token);
      if (!result.ok) {
        this.logger.error?.(`[token] fetched token failed validation: ${result.error}`);
        return null;
      }
    }
    return token;
  }

  // a cache slot whose TTL is the token's exp minus the entry's skew; no exp (or no token) => no slot, so the
  // next call refetches rather than risk presenting a token whose lifetime it can't bound.
  private slotFor(entry: Entry, token: string | null): CacheSlot | null {
    if (!token) return null;
    const exp = decodeJwt(token).exp;
    if (!exp) return null;
    return { token, expiresAtMs: exp * 1000 - (entry.config.skewMs ?? DEFAULT_SKEW_MS) };
  }

  private storeObo(entry: Entry, subjectToken: string, token: string | null): void {
    const slot = this.slotFor(entry, token);
    if (slot) entry.obo.set(subjectToken, slot);
    else entry.obo.delete(subjectToken);
    this.pruneObo(entry);
  }

  // drop expired OBO slots so the per-subject map can't grow without bound as users churn through
  private pruneObo(entry: Entry): void {
    const now = Date.now();
    for (const [key, slot] of entry.obo) {
      if (now >= slot.expiresAtMs) entry.obo.delete(key);
    }
  }
}
