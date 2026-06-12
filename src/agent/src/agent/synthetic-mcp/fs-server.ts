/**
 * In-process filesystem/search MCP server.
 *
 * This is the former spawned `fsmcp` stdio server, lifted into the agent
 * process. It owns the same seven filesystem/search tools, but it is no longer
 * fronted by an SDK `Server` reached over an in-memory transport: the tools are
 * exposed directly as a `LocalMcp`, so a tool call is a plain in-process
 * function call — no JSON-RPC round-trip.
 *
 * From the registry's perspective a `LocalMcp` is indistinguishable from a
 * spawned stdio server (`McpClient`): both satisfy the `Mcp` interface.
 *
 * The workspace root is injected (rather than read from AGENT_WORKSPACE) so the
 * tools resolve files to the SAME sandbox root the agent is configured with.
 *
 * Architecture role: Repository / External layer. No agent logic here — pure
 * tool handlers behind a thin in-process adapter.
 */

import type { ZodTypeAny } from "zod";

import type { ToolDescriptor } from "../providers/provider.js";
import { LocalMcp, type LocalTool } from "../mcp/local-mcp.js";
import type { ToolExecutionResult } from "../mcp/mcp.js";

import { zodToJsonSchema } from "./fs-tools/schema-helpers.js";
import { createWorkspace, WorkspaceViolationError, type Workspace } from "./fs-tools/workspace.js";

import { readFile, readFileSchema } from "./fs-tools/read-file.js";
import { writeFile, writeFileSchema } from "./fs-tools/write-file.js";
import { editFile, editFileSchema, EditFileError } from "./fs-tools/edit-file.js";
import { deleteFile, deleteFileSchema, DeleteFileError } from "./fs-tools/delete-file.js";
import { listDir, listDirSchema } from "./fs-tools/list-dir.js";
import { glob, globSchema } from "./fs-tools/glob.js";
import { grep, grepSchema } from "./fs-tools/grep.js";

/** The MCP server name this module mounts under (tools namespace as `fsmcp__*`). */
export const FS_SERVER_NAME = "fsmcp";

/**
 * A registered tool, paired with its typed schema.
 *
 * `defineTool` accepts a typed schema + typed handler and packs them into a
 * uniform shape: the runtime handler takes `unknown` arguments and does the Zod
 * parse itself, keeping the tools array a single concrete type.
 */
interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  invoke: (rawArguments: unknown, workspace: Workspace) => Promise<unknown>;
}

function defineTool<Schema extends ZodTypeAny>(definition: {
  name: string;
  description: string;
  schema: Schema;
  handler: (input: ReturnType<Schema["parse"]>, workspace: Workspace) => Promise<unknown>;
}): RegisteredTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.schema,
    invoke: async (rawArguments, workspace) => {
      const parsedInput = definition.schema.parse(rawArguments ?? {});
      return definition.handler(parsedInput, workspace);
    },
  };
}

/** Build the filesystem/search tools. Order matches the former fsmcp listing. */
function createFsTools(): RegisteredTool[] {
  return [
    defineTool({
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Supports optional line ranges. " +
        "Returns total_lines, the returned_range, and the file content.",
      schema: readFileSchema,
      handler: (input, ws) => readFile(input, ws),
    }),
    defineTool({
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file in the workspace. Parent directories are " +
        "created automatically unless create_directories is set to false.",
      schema: writeFileSchema,
      handler: (input, ws) => writeFile(input, ws),
    }),
    defineTool({
      name: "edit_file",
      description:
        "Replace an exact substring within an existing file. The match must be unique " +
        "unless replace_all is true. Fails if old_string is not found verbatim.",
      schema: editFileSchema,
      handler: (input, ws) => editFile(input, ws),
    }),
    defineTool({
      name: "delete_file",
      description:
        "Delete a file or directory in the workspace. Files are removed directly; " +
        "deleting a directory requires recursive: true and removes all of its contents. " +
        "Refuses to delete the workspace root and fails if the path does not exist.",
      schema: deleteFileSchema,
      handler: (input, ws) => deleteFile(input, ws),
    }),
    defineTool({
      name: "list_dir",
      description:
        "List the contents of a directory inside the workspace. Directories are returned " +
        "first, then files, alphabetically.",
      schema: listDirSchema,
      handler: (input, ws) => listDir(input, ws),
    }),
    defineTool({
      name: "glob",
      description:
        'Find files in the workspace by glob pattern (e.g. "src/**/*.ts"). Returns paths ' +
        "relative to the workspace root.",
      schema: globSchema,
      handler: (input, ws) => glob(input, ws),
    }),
    defineTool({
      name: "grep",
      description:
        "Search file contents in the workspace using a JavaScript regular expression. " +
        "Skips binary files, node_modules, .git, and dist by default.",
      schema: grepSchema,
      handler: (input, ws) => grep(input, ws),
    }),
  ];
}

/**
 * Render a tool error the same way the former fsmcp server did, so result
 * strings the agent already parses stay byte-for-byte compatible.
 */
function formatToolError(err: unknown): string {
  if (err instanceof WorkspaceViolationError) {
    return `Workspace violation: ${err.message}`;
  }
  if (err instanceof EditFileError) {
    return `Edit failed: ${err.message}`;
  }
  if (err instanceof DeleteFileError) {
    return `Delete failed: ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return `Unknown error: ${String(err)}`;
}

/**
 * Adapt a `RegisteredTool` (Zod schema + workspace-bound handler) into a
 * `LocalTool`: a JSON-schema descriptor plus a direct invocation that does the
 * Zod parse, serializes the result, and shapes errors exactly as the former
 * stdio server's `CallTool` handler did.
 */
function toLocalTool(tool: RegisteredTool, workspace: Workspace): LocalTool {
  const descriptor: ToolDescriptor = {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
  };

  return {
    descriptor,
    invoke: async (args): Promise<ToolExecutionResult> => {
      try {
        const result = await tool.invoke(args, workspace);
        return { isError: false, content: JSON.stringify(result, null, 2) };
      } catch (err) {
        return { isError: true, content: formatToolError(err) };
      }
    },
  };
}

/**
 * Build the in-process fsmcp server as a `LocalMcp` bound to `workspaceRoot`.
 *
 * The returned server can be registered directly with the MCP registry and is
 * indistinguishable from a spawned stdio server to every consumer.
 */
export function createFsLocalMcp(workspaceRoot: string): LocalMcp {
  const workspace = createWorkspace(workspaceRoot);
  const tools = createFsTools().map((tool) => toLocalTool(tool, workspace));
  return new LocalMcp(FS_SERVER_NAME, tools);
}

/** The read-only filesystem mount (tools namespace as `fsreadonly__*`). */
export const FS_READONLY_SERVER_NAME = "fsreadonly";

/**
 * ALLOWLIST, not a denylist: a mutating tool added to `createFsTools` later
 * stays out of the read-only mount unless deliberately listed here — the safe
 * failure mode for an enforcement boundary.
 */
const READ_ONLY_FS_TOOL_NAMES = new Set(["read_file", "list_dir", "glob", "grep"]);

/**
 * The read-only filesystem mount for coordinator roles. The orchestrator's
 * "read-only" contract was previously prompt-level only — its models.json
 * whitelist granted the whole fsmcp server, mutations included. Mounting an
 * inspection-only subset under its own server name turns that contract into
 * an enforced boundary: write/edit/delete are not advertised AND not callable,
 * regardless of what the model decides to try.
 */
export function createFsReadonlyLocalMcp(workspaceRoot: string): LocalMcp {
  const workspace = createWorkspace(workspaceRoot);
  const tools = createFsTools()
    .filter((tool) => READ_ONLY_FS_TOOL_NAMES.has(tool.name))
    .map((tool) => toLocalTool(tool, workspace));
  return new LocalMcp(FS_READONLY_SERVER_NAME, tools);
}
