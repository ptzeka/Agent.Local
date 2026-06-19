import type { ILogger } from "@agent-local/common";

// fetches the host's RS256 signing PUBLIC key (PEM) from its authority and memoizes it. The agent validates
// JWTs offline against this key, so it is fetched once; a failed fetch is not cached so the next call retries.
export function createPublicKeyProvider(authorityUrl: string, logger: ILogger): () => Promise<string> {
  let cached: string | null = null;
  const url = `${authorityUrl.replace(/\/$/, "")}/api/auth/public-key`;
  return async (): Promise<string> => {
    if (cached) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`public-key fetch failed: ${res.status} from ${url}`);
    cached = await res.text();
    logger.debug?.(`[agent-server] fetched signing public key from ${url}`);
    return cached;
  };
}
