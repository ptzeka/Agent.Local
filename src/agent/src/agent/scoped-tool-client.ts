import path from "node:path";

import type { RunnerListener } from "./runners/runner-events.js";
import { OrchestratorEventTypes } from "./runners/runner-events.js";
import type { Mcp, ToolExecutionResult, ToolInvoker } from "./mcp/mcp.js";
import type { ToolDescriptor } from "./providers/provider.js";

/**
 * ScopedToolClient — per-workspace path clamp at the agent's tool-call boundary.
 *
 * The fsmcp server is deliberately agnostic: it confines file I/O to a single
 * container root (AGENT_WORKSPACE = src/agent/workspace) and knows nothing about
 * workspace segmentation. Segmentation is the AGENT's job, and it lives here.
 *
 * Bound to one `workspaceId`, this wrapper rewrites the path-bearing argument of
 * every fsmcp tool so it resolves under `{workspaceId}/` inside the container,
 * and rejects any path that tries to escape that segment (absolute paths, `..`).
 * The enforcement is deterministic and entirely in agent code — it does not
 * depend on the model cooperating. On the way back, it strips the `{workspaceId}/`
 * prefix off result paths so the model always works in a clean, workspace-relative
 * coordinate system (and therefore round-trips paths without ever seeing the
 * segment).
 *
 * Non-fsmcp tools (codemcp's repo-wide code search) and tool listings are
 * delegated untouched, so the orchestrator keeps repo-wide read visibility.
 */

const FS_SERVER_NAME = "fsmcp";

/**
 * Which input field carries the workspace path, keyed by the tool's tail name
 * (the part after `<server>__`). fsmcp's `grep` has no cwd and globs from the
 * root, so it is confined via `path_glob` rather than a path argument.
 */
const INPUT_FIELD_BY_TAIL: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  delete_file: "path",
  list_dir: "path",
  glob: "cwd",
  grep: "path_glob",
};

/**
 * The default fsmcp applies when the path field is omitted. We must inject a
 * SCOPED default ourselves: if we let the field stay absent, fsmcp would fall
 * back to its own default (".", "**​/*") which resolves to the container root and
 * silently bypasses the segment.
 */
const DEFAULT_VALUE_BY_TAIL: Record<string, string> = {
  list_dir: ".",
  glob: ".",
  grep: "**/*",
};

export class ScopeViolationError extends Error {
  constructor(requestedPath: string, workspaceId: string) {
    super(
      `Path "${requestedPath}" escapes workspace segment "${workspaceId}". ` +
        `Tool calls are confined to the workspace; use a relative path inside it.`
    );
    this.name = "ScopeViolationError";
  }
}

export class ScopedToolClient implements ToolInvoker {
  /** The fronted servers, keyed by server name for `<server>__<tool>` routing. */
  private readonly clientsByServer: Map<string, Mcp>;

  constructor(
    clients: Mcp[],
    private readonly workspaceId: string,
    private readonly emit?: RunnerListener
  ) {
    this.clientsByServer = new Map(clients.map((client) => [client.name, client]));
  }

  /** Union of every fronted server's tools (namespaced `<server>__<tool>` descriptors). */
  public listTools(): ToolDescriptor[] {
    const tools: ToolDescriptor[] = [];
    for (const client of this.clientsByServer.values()) {
      tools.push(...client.listTools());
    }
    return tools;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    // Route by the tool's `<server>__<tool>` namespace to the owning server, then
    // hand that server the bare tool name (each server only knows its own tools).
    const separator = name.indexOf("__");
    const serverName = separator === -1 ? "" : name.slice(0, separator);
    const toolTail = separator === -1 ? name : name.slice(separator + 2);
    const client = this.clientsByServer.get(serverName);
    if (!client) {
      return {
        isError: true,
        content: `Unknown tool "${name}": no server "${serverName}" mounted on this client.`,
      };
    }

    // Only fsmcp tools carry workspace paths and need clamping; everything else
    // (excel, codemcp, subsessions, …) passes through to its server verbatim.
    if (serverName !== FS_SERVER_NAME) {
      this.emit?.({ type: OrchestratorEventTypes.TOOL_CALL, data: { id: "", name, arguments: args } });
      const result = await client.callTool(toolTail, args);
      this.emit?.({
        type: OrchestratorEventTypes.TOOL_RESULT,
        data: { id: "", name, isError: result.isError, contentPreview: result.content.slice(0, 400) },
      });
      return result;
    }

    const inputField = INPUT_FIELD_BY_TAIL[toolTail];
    if (!inputField) {
      // An fsmcp tool with no path surface (none today) — nothing to clamp.
      return client.callTool(toolTail, args);
    }

    let scopedArgs: Record<string, unknown>;
    try {
      scopedArgs = this.scopeArgs(toolTail, inputField, args);
    } catch (err) {
      if (err instanceof ScopeViolationError) {
        // Surface as a tool error rather than throwing, so the orchestrator
        // loop treats it like any other failed call and can re-plan.
        return { isError: true, content: `[scope-error] ${err.message}` };
      }
      throw err;
    }

    this.emit?.({ type: OrchestratorEventTypes.TOOL_CALL, data: { id: "", name, arguments: args } });
    const result = await client.callTool(toolTail, scopedArgs);
    const stripped = this.stripResult(toolTail, result);
    this.emit?.({
      type: OrchestratorEventTypes.TOOL_RESULT,
      data: { id: "", name, isError: stripped.isError, contentPreview: stripped.content.slice(0, 400) },
    });
    return stripped;
  }

  // --------------------------------------------------------------------------

  /** Clone of `args` with the path-bearing field rewritten under the segment. */
  private scopeArgs(
    toolTail: string,
    inputField: string,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const raw = args[inputField];

    // Resolve the effective value, injecting the scoped default when the field
    // is absent so an omitted path can't fall through to the container root.
    let value: string;
    if (typeof raw === "string") {
      value = raw;
    } else if (raw === undefined && toolTail in DEFAULT_VALUE_BY_TAIL) {
      value = DEFAULT_VALUE_BY_TAIL[toolTail];
    } else if (raw === undefined) {
      // Required path field missing — let fsmcp's own schema reject it.
      return args;
    } else {
      // Non-string path (number, object, …) — leave it for fsmcp to reject.
      return args;
    }

    return { ...args, [inputField]: this.scopeValue(value) };
  }

  /**
   * Prefix a workspace-relative value with the segment, idempotently, and
   * reject anything that escapes it. Works for both plain paths and glob
   * patterns (e.g. `**​/*` → `{id}/**​/*`); the segment prefix is a literal
   * directory the pattern is anchored under.
   */
  private scopeValue(value: string): string {
    if (isAbsoluteLike(value)) {
      throw new ScopeViolationError(value, this.workspaceId);
    }

    const segment = this.workspaceId;
    const normalizedInput = toPosix(value);

    // Idempotency: don't double-prefix a value that is already scoped (e.g. a
    // path the model copied from an earlier, pre-strip context).
    const alreadyScoped =
      normalizedInput === segment || normalizedInput.startsWith(`${segment}/`);
    const joined = alreadyScoped ? normalizedInput : `${segment}/${normalizedInput}`;

    // Collapse any `.`/`..` segments, then confirm we are still inside the
    // segment. A `..` that climbs out lands outside and is refused here.
    const normalized = path.posix.normalize(joined);
    if (normalized !== segment && !normalized.startsWith(`${segment}/`)) {
      throw new ScopeViolationError(value, this.workspaceId);
    }
    return normalized;
  }

  /**
   * Strip the `{workspaceId}/` prefix off path fields in the tool result so the
   * model only ever sees workspace-relative paths. Result bodies are fsmcp's
   * pretty-printed JSON; if parsing or the expected shape isn't there, we return
   * the result untouched (read_file content, errors, other servers).
   */
  private stripResult(toolTail: string, result: ToolExecutionResult): ToolExecutionResult {
    if (result.isError) return result;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      return result;
    }
    if (parsed === null || typeof parsed !== "object") return result;

    const body = parsed as Record<string, unknown>;
    let changed = false;

    const unscopeField = (key: string): void => {
      if (typeof body[key] === "string") {
        body[key] = this.unscopeValue(body[key] as string);
        changed = true;
      }
    };

    // `path`/`cwd` scalar fields (read/write/edit/delete/list, glob).
    unscopeField("path");
    unscopeField("cwd");

    // glob: matches is a flat string[] of paths.
    if (toolTail === "glob" && Array.isArray(body.matches)) {
      body.matches = (body.matches as unknown[]).map((m) =>
        typeof m === "string" ? this.unscopeValue(m) : m
      );
      changed = true;
    }

    // grep: matches is an array of { path, line_number, line }.
    if (toolTail === "grep" && Array.isArray(body.matches)) {
      body.matches = (body.matches as unknown[]).map((m) => {
        if (m && typeof m === "object" && typeof (m as Record<string, unknown>).path === "string") {
          const match = m as Record<string, unknown>;
          return { ...match, path: this.unscopeValue(match.path as string) };
        }
        return m;
      });
      changed = true;
    }

    if (!changed) return result;
    return { isError: result.isError, content: JSON.stringify(body, null, 2) };
  }

  /** Inverse of `scopeValue` for display: drop the leading segment. */
  private unscopeValue(value: string): string {
    const segment = this.workspaceId;
    const normalized = toPosix(value);
    if (normalized === segment) return ".";
    if (normalized.startsWith(`${segment}/`)) return normalized.slice(segment.length + 1);
    return value;
  }
}

// ---------------------------------------------------------------------------

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

/**
 * Treat drive-letter (`C:\`, `C:/`), UNC, and rooted (`/foo`, `\foo`) paths as
 * absolute. We reject these outright rather than try to relativize them, so the
 * clamp stays deterministic and a stray absolute path can never reach disk.
 */
function isAbsoluteLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]/.test(value);
}
