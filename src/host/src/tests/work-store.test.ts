import { openDatabase, ensureSchema, type DatabaseHandle } from "@agent-local/common/db";
import { HOST_SCHEMA, readStatusCodes } from "../db/db-schema.js";
import { WorkStore } from "../work/work-store.js";

// each test gets its own in-memory db at the real HOST_SCHEMA, so the store runs against the exact
// tables/indexes/FKs production uses — including the partial-unique session indexes and the status FK domain
function freshStore(): { db: DatabaseHandle; store: WorkStore } {
  const db = openDatabase(":memory:");
  ensureSchema(db, HOST_SCHEMA);
  return { db, store: WorkStore.create(db) };
}

describe("WorkStore", () => {
  let db: DatabaseHandle;
  let store: WorkStore;

  beforeEach(() => {
    ({ db, store } = freshStore());
  });

  afterEach(() => {
    db.close();
  });

  test("add seeds a new work and get folds it back into one record", async () => {
    const added = await store.add("w1", "user-a", "wf-1", "ws-1");
    expect(added).toMatchObject({
      workId: "w1",
      userId: "user-a",
      workflowId: "wf-1",
      workspaceId: "ws-1",
      status: "new",
      step: null,
      temporalId: null,
    });
    expect(await store.get("w1")).toEqual(added);
  });

  test("get returns null for a work that was never added", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  test("update patches work fields, bumps ts, and returns the rejoined record", async () => {
    const added = await store.add("w1", "user-a");
    const updated = await store.update("w1", { status: "running", step: "step-1" });
    expect(updated).toMatchObject({ status: "running", step: "step-1", createdAt: added.createdAt });
    expect(updated!.ts >= added.ts).toBe(true);
  });

  test("update returns null for an unknown work", async () => {
    expect(await store.update("missing", { status: "running" })).toBeNull();
  });

  test("temporalId upserts the child row and null releases it", async () => {
    await store.add("w1", "user-a");
    expect((await store.update("w1", { temporalId: "t-1" }))!.temporalId).toBe("t-1");
    expect((await store.update("w1", { temporalId: "t-2" }))!.temporalId).toBe("t-2");
    expect((await store.update("w1", { temporalId: null }))!.temporalId).toBeNull();
  });

  test("an omitted patch field is left untouched, an explicit null clears it", async () => {
    await store.add("w1", "user-a", "wf-1");
    await store.update("w1", { step: "step-1" });
    expect(await store.get("w1")).toMatchObject({ workflowId: "wf-1", step: "step-1" });
    expect(await store.update("w1", { workflowId: null })).toMatchObject({ workflowId: null, step: "step-1" });
  });

  test("search scopes to owner and status", async () => {
    await store.add("w1", "user-a");
    await store.add("w2", "user-a");
    await store.add("w3", "user-b");
    await store.update("w2", { status: "running" });

    expect((await store.search({ userId: "user-a" })).map((w) => w.workId).sort()).toEqual(["w1", "w2"]);
    expect((await store.search({ userId: "user-a", status: "running" })).map((w) => w.workId)).toEqual(["w2"]);
    expect(await store.search({ userId: "user-b", status: "running" })).toEqual([]);
  });

  test("cli session binding is one row per work and re-binding replaces it", async () => {
    await store.add("w1", "user-a");
    expect(await store.getCliSessionId("w1")).toBeNull();
    await store.setCliSessionId("w1", "s-1");
    await store.setCliSessionId("w1", "s-2");
    expect(await store.getCliSessionId("w1")).toBe("s-2");
  });

  test("job sessions key by (work, run, step) and remove is idempotent", async () => {
    await store.add("w1", "user-a");
    await store.addJobSession("w1", "s-1", "run-1", "step-1");
    await store.addJobSession("w1", "s-2", "run-1", "step-2");

    expect(await store.getJobSessionId("w1", "run-1", "step-1")).toBe("s-1");
    expect(await store.getJobSessionId("w1", "run-1", "step-9")).toBeNull();
    expect((await store.listJobSessionIds("w1")).sort()).toEqual(["s-1", "s-2"]);

    await store.removeJobSession("s-1");
    await store.removeJobSession("s-1");
    expect(await store.listJobSessionIds("w1")).toEqual(["s-2"]);
    // the cli binding is a different kind and must survive the job sweep
    await store.setCliSessionId("w1", "s-cli");
    await store.removeJobSession("s-cli");
    expect(await store.getCliSessionId("w1")).toBe("s-cli");
  });

  test("status lookup is seeded from the canonical catalog and gates unknown statuses", async () => {
    const codes = readStatusCodes(db);
    expect(codes.map((c) => c.status)).toEqual(expect.arrayContaining(["new", "running", "complete"]));
    await store.add("w1", "user-a");
    // FK domain: a status outside work_status must be rejected at the db, not stored silently
    await expect(store.update("w1", { status: "bogus" as never })).rejects.toThrow();
  });
});
