import { canonicalJson, sha256Text } from '@yantra/core';

/** Provider-neutral tool metadata included in the stable catalog hash. */
export interface HashableToolDefinition {
  readonly name: string;
  readonly schema: unknown;
  readonly description: string;
}

export { canonicalJson, sha256Text };

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
