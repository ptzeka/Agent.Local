import type { ToolDescriptor } from "@agent-local/mcp/tooldescriptor";
import type { Mcp } from "@agent-local/mcp";
import type { ResiliencePolicy } from "../resilience.js";

export class McpClientRegistry {
  private clients = new Map<string, Mcp>();
  private workspaceRootValue: string;

  // owned here, not on the per-turn ScopedToolClient, so breaker state is per RUNTIME and a server
  // that died stays open across turns rather than being re-probed by each new turn
  constructor(workspaceRoot: string, readonly resilience?: ResiliencePolicy) {
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
  public listClients(): Mcp[] {
    return [...this.clients.values()];
  }
  public listTools(): ToolDescriptor[] {
    const flattened: ToolDescriptor[] = [];
    for (const client of this.clients.values()) {
      flattened.push(...client.listTools());
    }
    return flattened;
  }
}