import type { ToolDescriptor } from "../providers/provider.js";
import type { Mcp } from "../mcp/mcp.js";

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
    this.clients.set(client.name, client);
  }
  public getClient(name: string): Mcp | undefined {
    return this.clients.get(name);
  }
  public listTools(): ToolDescriptor[] {
    const flattened: ToolDescriptor[] = [];
    for (const client of this.clients.values()) {
      flattened.push(...client.listTools());
    }
    return flattened;
  }
}