import { z, type ZodTypeAny } from "zod";

/**
 * Minimal Zod → JSON Schema converter.
 *
 * MCP tools (and Ollama's tool-calling API) both expect each tool to advertise
 * a JSON Schema for its arguments. Rather than pull in the full `zod-to-json-schema`
 * package, we implement just enough of the conversion to cover the schemas our
 * tools actually use: objects of primitives with optionals, defaults, and descriptions.
 *
 * Supported node types:
 *   - ZodObject          → { type: "object", properties, required }
 *   - ZodString          → { type: "string" }
 *   - ZodNumber          → { type: "number" } or { type: "integer" } if .int() applied
 *   - ZodBoolean         → { type: "boolean" }
 *   - ZodOptional        → unwraps inner type; key omitted from `required`
 *   - ZodDefault         → unwraps inner type; copies default into the schema
 *   - ZodEnum            → { type: "string", enum: [...] }
 *
 * Anything else falls back to `{}` so the tool still works even if the model
 * sees a slightly loose schema.
 */

interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  exclusiveMinimum?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchemaNode {
  return convertNode(schema);
}

function convertNode(node: ZodTypeAny): JsonSchemaNode {
  const description = node.description;

  if (node instanceof z.ZodObject) {
    return convertObject(node, description);
  }
  if (node instanceof z.ZodString) {
    return withDescription({ type: "string" }, description);
  }
  if (node instanceof z.ZodNumber) {
    return convertNumber(node, description);
  }
  if (node instanceof z.ZodBoolean) {
    return withDescription({ type: "boolean" }, description);
  }
  if (node instanceof z.ZodEnum) {
    return withDescription({ type: "string", enum: [...node.options] }, description);
  }
  if (node instanceof z.ZodOptional) {
    return convertNode(node.unwrap());
  }
  if (node instanceof z.ZodDefault) {
    const inner = convertNode(node.removeDefault());
    inner.default = node._def.defaultValue();
    return withDescription(inner, description ?? inner.description);
  }

  // Unknown node type — return an empty schema so callers don't blow up.
  return withDescription({}, description);
}

function convertObject(node: z.ZodObject<z.ZodRawShape>, description?: string): JsonSchemaNode {
  const shape = node.shape;
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const [key, child] of Object.entries(shape)) {
    properties[key] = convertNode(child as ZodTypeAny);

    // A property is "required" only if it has neither .optional() nor .default().
    if (!isOptionalOrDefaulted(child as ZodTypeAny)) {
      required.push(key);
    }
  }

  const result: JsonSchemaNode = {
    type: "object",
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) result.required = required;
  return withDescription(result, description);
}

function convertNumber(node: z.ZodNumber, description?: string): JsonSchemaNode {
  const checks = node._def.checks ?? [];
  const isInt = checks.some((check) => check.kind === "int");

  const schema: JsonSchemaNode = { type: isInt ? "integer" : "number" };

  for (const check of checks) {
    if (check.kind === "min") {
      if (check.inclusive) schema.minimum = check.value;
      else schema.exclusiveMinimum = check.value;
    }
  }

  return withDescription(schema, description);
}

function isOptionalOrDefaulted(node: ZodTypeAny): boolean {
  return node instanceof z.ZodOptional || node instanceof z.ZodDefault;
}

function withDescription(schema: JsonSchemaNode, description: string | undefined): JsonSchemaNode {
  if (description) schema.description = description;
  return schema;
}
