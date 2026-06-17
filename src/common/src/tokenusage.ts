// all fields optional so a producer that can't report a figure omits it; *Tallied present when the producer had dependencies
export interface TokenUsage {
  // which session spent it: a usage record flows past its origin runtime, so it carries its own attribution
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  inputTokensTallied?: number;
  outputTokensTallied?: number;
  cacheReadInputTokensTallied?: number;
  cacheCreationInputTokensTallied?: number;
}
