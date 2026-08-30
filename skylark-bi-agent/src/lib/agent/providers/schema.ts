/**
 * Tool-schema portability.
 *
 * The three providers accept three different dialects of JSON Schema:
 *
 *   Anthropic  full JSON Schema; tolerates a property with no declared type.
 *   Groq       OpenAI function schema; tolerant, but untyped properties are
 *              coerced unpredictably by open models.
 *   Gemini     an OpenAPI 3.0 subset. Rejects `additionalProperties`, wants
 *              UPPERCASE type names, and refuses a property with no `type`
 *              at all — which several of our filter fields deliberately had,
 *              because a filter value can be a string, a number OR an array.
 *
 * Rather than maintain three schema variants, every provider gets the SAME
 * sanitised schema: loosely-typed values are declared as strings with explicit
 * encoding instructions, and `coerceFilterValues` in the filter layer parses
 * them back. One contract, identical behaviour everywhere, and as a bonus it
 * hardens the system against any model that decides to send "1000" instead
 * of 1000 — which they all do sooner or later.
 */

type Json = Record<string, unknown>;

const GEMINI_TYPES: Record<string, string> = {
  string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
  boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT',
};

/** Keys Gemini's Schema message does not define and rejects outright. */
const UNSUPPORTED = new Set([
  'additionalProperties', '$schema', '$id', '$ref', 'definitions', '$defs',
  'default', 'examples', 'const', 'oneOf', 'allOf', 'not',
  'patternProperties', 'dependencies', 'if', 'then', 'else',
]);

/**
 * Guidance appended when a value could legitimately be several types. Without
 * this, a model told the field is a string will send `Mining` where an array
 * of sectors was meant, and the filter silently matches nothing.
 */
const POLYMORPHIC_HINT =
  'Encode as text: a number as digits ("1000000"), a list as a JSON array ' +
  '(["Mining","Renewables"]), a boolean as "true" or "false", a date as ' +
  'YYYY-MM-DD.';

function walk(node: unknown, uppercase: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, uppercase));
  if (!node || typeof node !== 'object') return node;

  const src = node as Json;
  const out: Json = {};

  for (const [key, value] of Object.entries(src)) {
    if (UNSUPPORTED.has(key)) continue;

    if (key === 'properties' && value && typeof value === 'object') {
      const props: Json = {};
      for (const [name, sub] of Object.entries(value as Json)) {
        props[name] = walk(sub, uppercase);
      }
      out.properties = props;
      continue;
    }

    if (key === 'items') { out.items = walk(value, uppercase); continue; }
    if (key === 'type' && typeof value === 'string') {
      out.type = uppercase ? (GEMINI_TYPES[value] ?? value.toUpperCase()) : value;
      continue;
    }
    out[key] = walk(value, uppercase);
  }

  // A property with no type: declare it a string and say how to encode.
  if (!('type' in out) && !('enum' in out) && ('description' in out || Object.keys(out).length === 0)) {
    out.type = uppercase ? 'STRING' : 'string';
    out.description = out.description ? `${String(out.description)} ${POLYMORPHIC_HINT}` : POLYMORPHIC_HINT;
  }

  // An enum with no type is invalid in the OpenAPI subset.
  if ('enum' in out && !('type' in out)) out.type = uppercase ? 'STRING' : 'string';

  // Gemini rejects an ARRAY with no items schema.
  if (out.type === 'ARRAY' && !('items' in out)) out.items = { type: 'STRING' };
  if (out.type === 'array' && !('items' in out)) out.items = { type: 'string' };

  return out;
}

export type SanitisedTool = {
  name: string;
  description: string;
  parameters: Json | undefined;
};

/**
 * `uppercaseTypes` is Gemini's protobuf enum requirement; Groq and Anthropic
 * take lowercase JSON Schema types.
 */
export function sanitiseTool(
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  opts: { uppercaseTypes: boolean },
): SanitisedTool {
  const schema = walk(tool.inputSchema, opts.uppercaseTypes) as Json;
  const props = (schema.properties ?? {}) as Json;

  // A function with no parameters must omit the schema entirely: Gemini
  // rejects `{type: OBJECT, properties: {}}` with an empty properties map.
  const parameters = Object.keys(props).length === 0 ? undefined : schema;

  return {
    name: tool.name,
    // Descriptions carry the data-quality guidance the agent needs; Gemini
    // truncates very long ones, so keep them within a safe bound.
    description: tool.description.slice(0, 1024),
    parameters,
  };
}

export function sanitiseTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  opts: { uppercaseTypes: boolean },
): SanitisedTool[] {
  return tools.map((t) => sanitiseTool(t, opts));
}
