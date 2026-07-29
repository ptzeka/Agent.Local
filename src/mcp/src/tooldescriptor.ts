// the declared RESPONSE contract, mirroring inputSchema's role for the payload: the JSON-Schema
// subset the client enforces (required present, enum honoured, per-field `default` filling a gap)
export interface ToolOutputSchema {
  required?: string[];
  // per field: `{ enum?, default? }` — enum constrains validation, default fills a missing/unparseable field
  properties?: Record<string, unknown>;
}

// the MCP tool shape: namespaced name, description, JSON-Schema inputs; shared by servers and providers
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // declaring this makes the CLIENT gate the response, so a server is held to its contract whether it
  // runs in-process or over stdio; omitted leaves the result untouched
  outputSchema?: ToolOutputSchema;
}
