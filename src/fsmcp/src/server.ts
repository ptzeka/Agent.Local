#!/usr/bin/env node
// stdio MCP server registering filesystem/search tools, all confined to AGENT_WORKSPACE

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./schema-helpers.js";

import { workspaceFromEnv, WorkspaceViolationError } from "./workspace.js";

import { readFile, readFileSchema } from "./fs/read-file.js";
import { writeFile, writeFileSchema } from "./fs/write-file.js";
import { editFile, editFileSchema, EditFileError } from "./fs/edit-file.js";
import { deleteFile, deleteFileSchema, DeleteFileError } from "./fs/delete-file.js";
import { listDir, listDirSchema } from "./fs/list-dir.js";
import { glob, globSchema } from "./search/glob.js";
import { grep, grepSchema } from "./search/grep.js";

import type { ZodTypeAny } from "zod";
import type { Workspace } from "./workspace.js";

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

async function main(): Promise<void> {
  const workspace = await workspaceFromEnv();

  const tools = [
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
  ] as const;

  // every tool input is a top-level ZodObject, so the converter always yields type:"object"; cast to satisfy the SDK's literal field
  const toolListing: ListToolsResult = {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as ListToolsResult["tools"][number]["inputSchema"],
    })),
  };

  const server = new Server(
    {
      name: "fsmcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => toolListing);

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const toolName = request.params.name;
    const tool = tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${toolName}`,
          },
        ],
      };
    }

    try {
      const result = await tool.invoke(request.params.arguments, workspace);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: formatToolError(err),
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

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

main().catch((err) => {
  // stderr, not stdout, so a startup failure doesn't corrupt the MCP stdio channel
  process.stderr.write(`[fsmcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
