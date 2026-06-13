import type { ToolDescriptor } from "../providers/provider.js";
import type { Mcp } from "../mcp/mcp.js";
import { ScopedToolClient } from "../scoped-tool-client.js";

export class McpClientRegistry {
  private clients = new Map<string, Mcp>();
  private workspaceRootValue: string;

  constructor(workspaceRoot: string) {
    this.workspaceRootValue = workspaceRoot;
  }

  public get sandboxRoot(): string {
    return this.workspaceRootValue;
  }

  public registerClient(client: Mcp): void {
    // server name
    this.clients.set(client.name, client);
  }
  public getClient(serverName: string): Mcp | undefined {
    return this.clients.get(serverName);
  }
  public listTools(): ToolDescriptor[] {
    const flattened: ToolDescriptor[] = [];
    for (const client of this.clients.values()) {
      flattened.push(...client.listTools());
    }
    return flattened;
  }

  // The middleware already mounts only this role's whitelisted servers, so the
  // scoped client simply fronts every registered mount. Built per turn so it
  // sees live rebinds (e.g. the subsessions server swapped for the coordinator).
  public createScopedClient(): ScopedToolClient {
    return new ScopedToolClient([...this.clients.values()]);
  }
}