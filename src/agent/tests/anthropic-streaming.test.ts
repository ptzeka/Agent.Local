import { describe, expect, test } from "@jest/globals";

import { AnthropicProvider } from "../src/agent/providers/anthropic-provider.js";

// pins the M1-11b provider contract: text deltas reach the onDelta sink while finalMessage() stays the
// whole message, so the persisted/append path is byte-identical whether or not anyone is streaming.

// minimal stand-in for the SDK MessageStream: replays deltas through the "text" listener on finalMessage()
function fakeStream(deltas: string[]) {
  let onText: ((d: string) => void) | undefined;
  return {
    subscribed: () => onText !== undefined,
    on(event: string, cb: (d: string) => void) {
      if (event === "text") onText = cb;
      return this;
    },
    async finalMessage() {
      for (const delta of deltas) onText?.(delta);
      return {
        content: [{ type: "text", text: deltas.join("") }],
        usage: { input_tokens: 1, output_tokens: deltas.length },
      };
    },
  };
}

function providerWithStream(stream: ReturnType<typeof fakeStream>): AnthropicProvider {
  const provider = new AnthropicProvider({ apiKey: "test", model: "claude-x", supportsNativeTools: false });
  // swap the real SDK client for one whose stream() yields our fake
  (provider as unknown as { client: unknown }).client = {
    messages: { stream: () => stream },
  };
  return provider;
}

describe("AnthropicProvider streaming", () => {
  test("forwards each text delta and still returns the full finalMessage", async () => {
    const deltas = ["Hel", "lo", " world"];
    const provider = providerWithStream(fakeStream(deltas));

    const collected: string[] = [];
    const response = await provider.chat([{ role: "user", content: "hi" }], {
      tools: [],
      onDelta: (d) => collected.push(d),
    });

    expect(collected).toEqual(deltas);
    expect(response.message.content).toBe("Hello world");
  });

  test("without a sink it stays collect-only (never subscribes to text)", async () => {
    const stream = fakeStream(["ignored"]);
    const provider = providerWithStream(stream);

    const response = await provider.chat([{ role: "user", content: "hi" }], { tools: [] });

    expect(stream.subscribed()).toBe(false);
    expect(response.message.content).toBe("ignored");
  });
});
