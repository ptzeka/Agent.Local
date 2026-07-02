import { describe, it, expect, afterEach } from "@jest/globals";
import {
  createEmbedAdapter,
  VectorService,
  VectorServiceBase,
  type EmbedAdapter,
} from "@agent-local/vectorizer";

const DIM = 64;

describe("local embed adapter", () => {
  const adapter = createEmbedAdapter("local", DIM);

  it("stamps a dim-tagged modelId and the requested dimension", () => {
    expect(adapter.dim).toBe(DIM);
    expect(adapter.modelId).toBe(`local:hashed-bag-v2-${DIM}`);
  });

  it("embeds a query identically to the same text as a document", async () => {
    // the whole point of the local mirror: query and index side must collide for cosine search to work
    const [doc] = await adapter.embedBatch(["payment service retry"]);
    const query = await adapter.embedQuery("payment service retry");
    expect(query).toEqual(doc);
  });

  it("L2-normalizes non-empty input", async () => {
    const query = await adapter.embedQuery("alpha beta gamma");
    const norm = Math.sqrt(query.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe("createEmbedAdapter", () => {
  it("rejects an unknown provider", () => {
    // cast through unknown so the factory's runtime guard is exercised, not just the type
    expect(() => createEmbedAdapter("bogus" as unknown as "local", DIM)).toThrow(
      /Unknown embed provider/,
    );
  });
});

describe("VectorService", () => {
  it("inherits the adapter identity and forwards both embed calls", async () => {
    const service = VectorService.fromProvider("local", DIM);
    const adapter = createEmbedAdapter("local", DIM);

    expect(service.modelId).toBe(adapter.modelId);
    expect(service.dim).toBe(DIM);
    expect(await service.embedQuery("x y z")).toEqual(await adapter.embedQuery("x y z"));
  });

  it("short-circuits an empty batch without touching the backend", async () => {
    let called = false;
    const spy: EmbedAdapter = {
      modelId: "spy:0",
      dim: DIM,
      async embedBatch() {
        called = true;
        return [];
      },
      async embedQuery() {
        return [];
      },
    };
    const service = new VectorService(spy);

    expect(await service.embedBatch([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("is a VectorServiceBase, so alternate versions share its contract", () => {
    expect(VectorService.fromProvider("local", DIM)).toBeInstanceOf(VectorServiceBase);
  });
});

describe("local embedding is a bag of words", () => {
  const adapter = createEmbedAdapter("local", DIM);

  it("ignores token order", async () => {
    const a = await adapter.embedQuery("retry payment service");
    const b = await adapter.embedQuery("service payment retry");
    expect(a).toEqual(b);
  });

  it("is case-insensitive", async () => {
    const a = await adapter.embedQuery("Payment SERVICE");
    const b = await adapter.embedQuery("payment service");
    expect(a).toEqual(b);
  });

  it("separates distinct content", async () => {
    const a = await adapter.embedQuery("authentication token");
    const b = await adapter.embedQuery("database migration");
    expect(a).not.toEqual(b);
  });

  it("yields a zero vector when nothing survives tokenization", async () => {
    // tokens under 2 chars are dropped, so initials-and-punctuation text has no signal to normalize
    const vec = await adapter.embedQuery("a . b , c");
    expect(vec).toHaveLength(DIM);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("decomposes camelCase/PascalCase/snake_case identifiers into matching subwords", async () => {
    // the whole point of the v2 tokenizer: a natural-language query shares tokens with an identifier
    // regardless of which naming convention the identifier happens to use
    const camel = await adapter.embedQuery("getUserById");
    const pascal = await adapter.embedQuery("GetUserById");
    const snake = await adapter.embedQuery("get_user_by_id");
    const words = await adapter.embedQuery("get user by id");
    expect(camel).toEqual(words);
    expect(pascal).toEqual(words);
    expect(snake).toEqual(words);
  });

  it("still splits acronym runs from a trailing word (XMLParser -> XML, Parser)", async () => {
    const acronym = await adapter.embedQuery("XMLParser");
    const words = await adapter.embedQuery("xml parser");
    expect(acronym).toEqual(words);
  });

  it("embeds a batch element-wise", async () => {
    const texts = ["first chunk", "second chunk", "third chunk"];
    const batch = await adapter.embedBatch(texts);
    for (let i = 0; i < texts.length; i++) {
      expect(batch[i]).toEqual(await adapter.embedQuery(texts[i]));
    }
  });
});

describe("voyage distinguishes documents from queries", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.VOYAGE_API_KEY;
  });

  it("sends input_type document for a batch and query for a query", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const inputTypes: string[] = [];
    // capture each request body's input_type instead of hitting the network
    global.fetch = (async (_url: string, init: RequestInit) => {
      inputTypes.push(JSON.parse(init.body as string).input_type);
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    }) as unknown as typeof fetch;

    const adapter = createEmbedAdapter("voyage", 2);
    await adapter.embedBatch(["a document"]);
    await adapter.embedQuery("a query");

    expect(inputTypes).toEqual(["document", "query"]);
  });
});
