// the former fsmcp stdio server lifted in-process as a LocalMcp: tool calls are plain function calls, no JSON-RPC
// workspace root is injected (not read from env) so tools resolve to the same sandbox the agent is configured with

import type { ZodTypeAny } from "zod";

import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import { LocalMcp, type LocalTool } from "@agent-local/mcp";
import type { ToolExecutionResult } from "@agent-local/mcp";

import { zodToJsonSchema } from "./fs-tools/schema-helpers.js";
import { createWorkspace, WorkspaceViolationError, type Workspace } from "./fs-tools/workspace.js";

import { readFile, readFileSchema } from "./fs-tools/read-file.js";
import { writeFile, writeFileSchema } from "./fs-tools/write-file.js";
import { editFile, editFileSchema, EditFileError } from "./fs-tools/edit-file.js";
import { deleteFile, deleteFileSchema, DeleteFileError } from "./fs-tools/delete-file.js";
import { listDir, listDirSchema } from "./fs-tools/list-dir.js";
import { glob, globSchema } from "./fs-tools/glob.js";
import { grep, grepSchema } from "./fs-tools/grep.js";

export const FS_SERVER_NAME = "fsmcp";

// the runtime handler takes unknown args and Zod-parses itself, keeping the tools array a single concrete type
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

// order matches the former fsmcp listing
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

// matches the former fsmcp wording so result strings the agent already parses stay byte-for-byte compatible
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

// adapts a RegisteredTool into a LocalTool, shaping errors exactly as the former stdio server's CallTool handler did
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

export function createFsLocalMcp(workspaceRoot: string): LocalMcp {
  const workspace = createWorkspace(workspaceRoot);
  const tools = createFsTools().map((tool) => toLocalTool(tool, workspace));
  return new LocalMcp(FS_SERVER_NAME, tools);
}

export const FS_READONLY_SERVER_NAME = "fsreadonly";

// ALLOWLIST, not a denylist: a mutating tool added later stays out unless listed here — the safe failure mode
const READ_ONLY_FS_TOOL_NAMES = new Set(["read_file", "list_dir", "glob", "grep"]);

// turns the orchestrator's prompt-level "read-only" into an enforced boundary: writes aren't advertised OR callable
export function createFsReadonlyLocalMcp(workspaceRoot: string): LocalMcp {
  const workspace = createWorkspace(workspaceRoot);
  const tools = createFsTools()
    .filter((tool) => READ_ONLY_FS_TOOL_NAMES.has(tool.name))
    .map((tool) => toLocalTool(tool, workspace));
  return new LocalMcp(FS_READONLY_SERVER_NAME, tools);
}
