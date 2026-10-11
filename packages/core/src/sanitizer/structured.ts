/**
 * Structural sanitization for JSON-shaped payloads (FEAT-048 TASK-001).
 *
 * The text sanitizer works on one serialized string. Applied to a structured
 * payload that is serialized, sanitized, and re-parsed, it can corrupt the JSON
 * it was handed: a URL pattern that swallows the `\` of an escaped quote, a
 * redaction marker landing on an unquoted number, or a byte cut in the middle
 * of a token. The stable audit projection (`tool-calls.jsonl`) then stores an
 * unparseable string, and every reader silently loses the details.
 *
 * This module sanitizes the payload's *leaves* instead. Every string leaf, and
 * every object key, passes the identical profile pass (`redactText`) the text
 * sanitizer uses, so redaction is never weaker. A string leaf that is itself
 * JSON (Pi's `content[].text`) is parsed, sanitized recursively, and
 * re-serialized. The profile's byte cap is enforced by shortening the longest
 * string leaves, never by cutting the serialized text, so the output is always
 * valid JSON.
 */

import { DEFAULT_HOST_OVERRIDES } from './host-overrides.js';
import {
  redactText,
  UNSERIALIZABLE_PAYLOAD_MARKER,
  type RedactionContext,
  type TransformationTag,
} from './pipeline.js';
import { getProfile, type SanitizationProfile } from './profiles.js';
import { truncateUtf8, utf8Prefix } from './truncate.js';

/** Marker appended to a string leaf shortened to honor the profile byte cap. */
export const STRUCTURED_TRUNCATION_MARKER = '…[truncated]';

/** Per-call controls for {@link sanitizeStructured}. */
export interface StructuredSanitizeOptions {
  /** Values the model itself supplied this run; shielded exactly as in `sanitize`. */
  readonly preserve?: readonly string[];
  /** Host name or URL used for per-host overrides. */
  readonly hostHint?: string;
}

/** Result of one structural sanitization pass. */
export interface StructuredSanitizeResult {
  /**
   * The sanitized value. JSON-compatible input yields a JSON-compatible value
   * whose `JSON.stringify` always re-parses; non-JSON input (cycles, bigint,
   * functions) degrades to a sanitized string, exactly as the text path does.
   */
  readonly value: unknown;
  /** De-duplicated redactor tags that hit, plus `truncate` when shortened. */
  readonly transformationsApplied: readonly TransformationTag[];
  /** True when any leaf was shortened (or array items dropped) for the byte cap. */
  readonly truncated: boolean;
}

/** Embedded JSON is recursed into at most this deep, a guard against pathology. */
const MAX_EMBEDDED_DEPTH = 8;
/** Bound on shortening iterations; past it the fallback stages take over. */
const MAX_SHRINK_ITERATIONS = 256;
const MARKER_BYTES = Buffer.byteLength(STRUCTURED_TRUNCATION_MARKER, 'utf8');

type Node =
  | { readonly kind: 'string'; text: string; cut: boolean }
  | { readonly kind: 'embedded'; readonly node: Node; readonly indent: string | undefined }
  | { readonly kind: 'array'; items: Node[]; dropped: number }
  | { readonly kind: 'object'; readonly entries: (readonly [string, Node])[] }
  | { readonly kind: 'literal'; readonly value: number | boolean | null };

type StringNode = Extract<Node, { kind: 'string' }>;
type ArrayNode = Extract<Node, { kind: 'array' }>;

/**
 * Sanitize a JSON-compatible value leaf by leaf, keeping it valid JSON.
 *
 * @param value Arbitrary payload (typically a tool's args or result).
 * @param profile Sanitization profile; its redactors apply to every leaf and
 *   its byte cap applies to the serialized result.
 * @param options Values to preserve and an optional host hint.
 */
export function sanitizeStructured(
  value: unknown,
  profile: SanitizationProfile,
  options?: StructuredSanitizeOptions,
): StructuredSanitizeResult {
  const profileDef = getProfile(profile);
  const tags: TransformationTag[] = [];
  const ctx: RedactionContext = {
    profileDef,
    hostOverrides: DEFAULT_HOST_OVERRIDES,
    ...(options?.hostHint === undefined ? {} : { hostHint: options.hostHint }),
    preserve: options?.preserve ?? [],
  };

  const json = toJsonTree(value);
  if (json.kind === 'degraded') {
    // Same coercion the text path performs: a string marker for cycles/bigint,
    // `String(value)` for functions/symbols/undefined. The result is a string,
    // which is still valid JSON.
    const redacted = redactText(json.text, ctx, tags);
    const bounded = truncateUtf8(redacted, profileDef.truncateBytes);
    if (bounded.truncated || json.coercionFailed) tags.push('truncate');
    return {
      value: bounded.text,
      transformationsApplied: dedupe(tags),
      truncated: bounded.truncated,
    };
  }

  const root = buildNode(json.value, ctx, tags, 0);
  const cap = enforceByteCap(root, profileDef.truncateBytes);
  if (cap.truncated) tags.push('truncate');
  // A structure that still overflows after every leaf and array was shortened
  // (deep objects with thousands of keys) is replaced by the marker string —
  // still valid JSON, never a cut serialization.
  const output = cap.fits ? materialize(root) : STRUCTURED_TRUNCATION_MARKER;
  return { value: output, transformationsApplied: dedupe(tags), truncated: cap.truncated };
}

type JsonTree =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'degraded'; readonly text: string; readonly coercionFailed: boolean };

/**
 * Normalize input to a plain JSON tree through one serialize/parse round trip,
 * which applies `toJSON`, drops `undefined` members, and rejects cycles and
 * bigint exactly as `JSON.stringify` does.
 */
function toJsonTree(value: unknown): JsonTree {
  if (typeof value === 'string') return { kind: 'json', value };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { kind: 'degraded', text: UNSERIALIZABLE_PAYLOAD_MARKER, coercionFailed: true };
  }
  if (serialized === undefined) {
    return { kind: 'degraded', text: String(value), coercionFailed: false };
  }
  return { kind: 'json', value: JSON.parse(serialized) as unknown };
}

function buildNode(
  value: unknown,
  ctx: RedactionContext,
  tags: TransformationTag[],
  depth: number,
): Node {
  if (typeof value === 'string') return buildStringNode(value, ctx, tags, depth);
  if (typeof value === 'number') {
    // A number can carry a PII shape (a card or account number stored as a
    // JSON number). The text path would have redacted its digits, so the
    // structural path must too: a redacted number becomes its marker string.
    const asText = String(value);
    const redacted = redactText(asText, ctx, tags);
    return redacted === asText
      ? { kind: 'literal', value }
      : { kind: 'string', text: redacted, cut: false };
  }
  if (typeof value === 'boolean' || value === null) return { kind: 'literal', value };
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      items: value.map((item) => buildNode(item, ctx, tags, depth)),
      dropped: 0,
    };
  }
  const entries: (readonly [string, Node])[] = [];
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    // Keys are text too: the serialized-text path redacted them, so this one does.
    entries.push([redactText(key, ctx, tags), buildNode(member, ctx, tags, depth)]);
  }
  return { kind: 'object', entries };
}

function buildStringNode(
  text: string,
  ctx: RedactionContext,
  tags: TransformationTag[],
  depth: number,
): Node {
  const embedded = depth < MAX_EMBEDDED_DEPTH ? parseEmbeddedJson(text) : undefined;
  if (embedded !== undefined) {
    return {
      kind: 'embedded',
      node: buildNode(embedded.value, ctx, tags, depth + 1),
      indent: embedded.indent,
    };
  }
  return { kind: 'string', text: redactText(text, ctx, tags), cut: false };
}

/**
 * A string leaf that is a serialized object or array. Scalars are left as
 * text: a leaf reading `"42"` or `"true"` is a string to its producer.
 */
function parseEmbeddedJson(
  text: string,
): { readonly value: unknown; readonly indent: string | undefined } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON after all; the leaf is sanitized as plain text instead.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  // Keep the producer's layout when it pretty-printed, so the audit copy reads
  // like the model-visible one.
  const indent = /^[[{]\r?\n([ \t]+)/.exec(trimmed)?.[1];
  return { value: parsed, indent };
}

function materialize(node: Node): unknown {
  switch (node.kind) {
    case 'string':
      return node.cut ? `${node.text}${STRUCTURED_TRUNCATION_MARKER}` : node.text;
    case 'literal':
      return node.value;
    case 'embedded':
      return JSON.stringify(materialize(node.node), null, node.indent);
    case 'array': {
      const items = node.items.map(materialize);
      return node.dropped > 0 ? [...items, `…[${node.dropped} more items truncated]`] : items;
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, member] of node.entries) out[key] = materialize(member);
      return out;
    }
  }
}

function serializedBytes(root: Node): number {
  return Buffer.byteLength(JSON.stringify(materialize(root)), 'utf8');
}

/**
 * Shrink the tree in place until its serialization fits `cap` bytes.
 *
 * Stage 1 shortens the longest string leaf (at any embedding depth) by the
 * current excess, repeatedly. Stage 2, reached only when the structure itself
 * is too large (thousands of tiny leaves), drops tail items of the longest
 * array. Every stage keeps the tree valid JSON.
 *
 * @returns Whether anything was shortened and whether the result now fits.
 */
function enforceByteCap(
  root: Node,
  cap: number,
): { readonly truncated: boolean; readonly fits: boolean } {
  let size = serializedBytes(root);
  if (size <= cap) return { truncated: false, fits: true };

  for (let i = 0; i < MAX_SHRINK_ITERATIONS && size > cap; i += 1) {
    const leaf = longestLeaf(root);
    if (leaf === undefined) break;
    const leafBytes = Buffer.byteLength(leaf.text, 'utf8');
    if (leafBytes <= MARKER_BYTES) break;
    const excess = size - cap;
    leaf.text = utf8Prefix(leaf.text, Math.max(0, leafBytes - excess - MARKER_BYTES));
    leaf.cut = true;
    size = serializedBytes(root);
  }

  for (let i = 0; i < MAX_SHRINK_ITERATIONS && size > cap; i += 1) {
    const array = longestArray(root);
    if (array === undefined) break;
    const keep = Math.max(0, Math.floor(array.items.length / 2));
    array.dropped += array.items.length - keep;
    array.items = array.items.slice(0, keep);
    size = serializedBytes(root);
  }

  return { truncated: true, fits: size <= cap };
}

function longestLeaf(node: Node): StringNode | undefined {
  let best: StringNode | undefined;
  let bestBytes = -1;
  const visit = (current: Node): void => {
    switch (current.kind) {
      case 'string': {
        const bytes = Buffer.byteLength(current.text, 'utf8');
        if (bytes > bestBytes) {
          best = current;
          bestBytes = bytes;
        }
        return;
      }
      case 'embedded':
        visit(current.node);
        return;
      case 'array':
        current.items.forEach(visit);
        return;
      case 'object':
        for (const [, member] of current.entries) visit(member);
        return;
      case 'literal':
        return;
    }
  };
  visit(node);
  return best;
}

function longestArray(node: Node): ArrayNode | undefined {
  let best: ArrayNode | undefined;
  const visit = (current: Node): void => {
    switch (current.kind) {
      case 'array':
        if (
          current.items.length > 1 &&
          (best === undefined || current.items.length > best.items.length)
        ) {
          best = current;
        }
        current.items.forEach(visit);
        return;
      case 'embedded':
        visit(current.node);
        return;
      case 'object':
        for (const [, member] of current.entries) visit(member);
        return;
      case 'string':
      case 'literal':
        return;
    }
  };
  visit(node);
  return best;
}

function dedupe(tags: readonly TransformationTag[]): TransformationTag[] {
  return [...new Set(tags)];
}
