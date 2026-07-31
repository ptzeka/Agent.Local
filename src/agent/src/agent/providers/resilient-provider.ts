import type { ResiliencePolicy } from "../resilience.js";
import { isTransientError } from "./retry.js";
import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from "./provider.js";

// the MODEL port's resilience seam: retry/backoff/breaker applied by composition, so a provider
// implementation contains no resilience code and a newly added backend inherits it for free
// keyed by provider+model, so one overloaded model does not pause calls to a healthy sibling
export class ResilientProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly policy: ResiliencePolicy
  ) {}

  get providerName(): string {
    return this.inner.providerName;
  }

  get modelId(): string {
    return this.inner.modelId;
  }

  get supportsNativeTools(): boolean {
    return this.inner.supportsNativeTools;
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    // the streaming carve-out that kept M1-1 inside the providers, solved at the port instead: wrapping
    // the caller's sink lets the decorator SEE that tokens were emitted, so a re-run can never double-emit
    let hasStreamed = false;
    const onDelta = options.onDelta
      ? (delta: string) => {
          hasStreamed = true;
          options.onDelta!(delta);
        }
      : undefined;

    return this.policy.run(
      `${this.providerName}:${this.modelId}`,
      () => this.inner.chat(messages, { ...options, onDelta }),
      {
        signal: options.signal,
        shouldRetry: (err) => !hasStreamed && isTransientError(err),
      }
    );
  }
}
