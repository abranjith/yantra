import { createHash } from 'node:crypto';

/** Provider-neutral tool metadata included in the stable catalog hash. */
export interface HashableToolDefinition {
  readonly name: string;
  readonly schema: unknown;
  readonly description: string;
}

/**
 * Serializes JSON-compatible data with recursively sorted object keys.
 *
 * @param value Data to canonicalize.
 * @returns Deterministic JSON independent of object insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/**
 * Computes the lowercase SHA-256 digest of exact text.
 *
 * @param text Exact prompt or canonical JSON text.
 * @returns A 64-character lowercase hexadecimal digest.
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hashes a tool catalog after sorting tools by name and every schema key.
 *
 * @param tools Stable tool names, descriptions, and input schemas.
 * @returns SHA-256 of the canonical catalog serialization.
 */
export function hashToolCatalog(tools: readonly HashableToolDefinition[]): string {
  const catalog = [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, schema, description }) => ({ name, schema, description }));
  return sha256Text(canonicalJson(catalog));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
