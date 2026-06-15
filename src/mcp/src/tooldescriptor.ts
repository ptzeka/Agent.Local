// the MCP tool shape: namespaced name, description, JSON-Schema inputs; shared by servers and providers
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
