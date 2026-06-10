/**
 * In-process filesystem/search MCP server.
 *
 * This is the former spawned `fsmcp` stdio server, lifted into the agent
 * process. It registers the same seven filesystem/search tools against a real
 * MCP `Server`, but instead of talking stdio to a child process it is linked to
 * a `Client` over an in-memory transport. The returned `{ serverName, client }`
 * pair is handed to `McpToolClient.connect`, which mounts it exactly like a
 * spawned server — an in-process MCP server is indistinguishable from one over
 * stdio.
 *
 * The workspace root is injected (rather than read from AGENT_WORKSPACE) so the
 * tools resolve files to the SAME sandbox root the agent is configured with.
 *
 * Architecture role: Repository / External layer. No agent logic here — pure
 * tool handlers behind a thin MCP transport wrapper.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { ZodTypeAny } from "zod";

import { zodToJsonSchema } from "./fs-tools/schema-helpers.js";
import { createWorkspace, WorkspaceViolationError, type Workspace } from "./fs-tools/workspace.js";

import { readFile, readFileSchema } from "./fs-tools/read-file.js";
import { writeFile, writeFileSchema } from "./fs-tools/write-file.js";
import { editFile, editFileSchema, EditFileError } from "./fs-tools/edit-file.js";
import { deleteFile, deleteFileSchema, DeleteFileError } from "./fs-tools/delete-file.js";
import { listDir, listDirSchema } from "./fs-tools/list-dir.js";
import { glob, globSchema } from "./fs-tools/glob.js";
import { grep, grepSchema } from "./fs-tools/grep.js";

/** A pre-connected in-process MCP server, ready for McpToolClient to mount. */
export interface InProcessMcpServer {
  serverName: string;
  client: Client;
}

/**
 * A registered tool, ready to be exposed over MCP.
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
 * Build the in-process fsmcp server, link it to a Client over an in-memory
 * transport, and return the connected `{ serverName, client }` pair.
 *
 * The Client is already `connect`ed, so the caller can immediately `listTools`
 * and `callTool` against it.
 */
export async function createFsMcpServer(workspaceRoot: string): Promise<InProcessMcpServer> {
  const workspace = createWorkspace(workspaceRoot);
  const tools = createFsTools();

  // Each tool input is a ZodObject at the top level, so the converter always
  // produces `type: "object"` here — we cast to satisfy the SDK's literal type.
  const toolListing: ListToolsResult = {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as ListToolsResult["tools"][number]["inputSchema"],
    })),
  };

  const server = new Server(
    { name: "fsmcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => toolListing);

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const toolName = request.params.name;
    const tool = tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
      };
    }

    try {
      const result = await tool.invoke(request.params.arguments, workspace);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: formatToolError(err) }],
      };
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "agent-local-client-fsmcp", version: "0.1.0" },
    { capabilities: {} }
  );

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { serverName: "fsmcp", client };
}
