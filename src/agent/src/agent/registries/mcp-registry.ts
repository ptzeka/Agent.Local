import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type { Mcp } from "@agent-local/mcp";

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
}