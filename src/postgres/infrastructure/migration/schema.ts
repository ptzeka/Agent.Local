import type { PgSchemaSpec } from "./dbup.js";
import { codeCommits } from "./tables/code-commits.js";
import { vectorRecordsTable } from "./tables/vector-records.js";

// the full target schema for agentlocal: every table dbup instruments, composed from the per-table
// modules. Embedding dimensions match each consumer's embed provider — codemcp local=768, memomcp
// voyage=1024 (see src/codemcp/src/config.ts and src/memomcp/src/config.ts). Change a dimension here
// and re-provision into a fresh table; a redesign adds a module and lists it below.
export const AGENT_LOCAL_SCHEMA: PgSchemaSpec = {
  extensions: ["vector"],
  tables: [
    codeCommits,
    vectorRecordsTable("code", 768),
    vectorRecordsTable("memo", 1024),
  ],
};
