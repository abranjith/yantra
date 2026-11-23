/**
 * The generated table's model (FEAT-070): where a command's `--json` document
 * keeps its rows, and which columns those rows have.
 *
 * Columns come from the **row** schema, never from the document's. A document
 * is usually an envelope (`schemaVersion`, `kind`, one row array, perhaps
 * totals); `yantra schedules --json` is a bare array. Deriving columns from
 * the envelope gave every Installation column a schema sentence for a header
 * and an empty cell, because no row has a `schemaVersion`.
 */

/** The slice of a Zod (v3) schema this model reads. */
export interface SchemaLike {
  readonly description?: string | undefined;
  readonly _def: {
    readonly typeName?: string;
    /** ZodOptional, ZodNullable, ZodDefault, ZodReadonly … */
    readonly innerType?: SchemaLike;
    /** ZodEffects. */
    readonly schema?: SchemaLike;
    /** ZodArray: the element. */
    readonly type?: SchemaLike;
    /** ZodUnion and ZodDiscriminatedUnion. */
    readonly options?: readonly SchemaLike[];
  };
  safeParse(value: unknown): { readonly success: boolean };
}

/** One column of a generated table. */
export interface GeneratedColumn {
  /** The row field. */
  readonly id: string;
  /** The field name in words: `totalCostUsd` reads "Total cost USD". */
  readonly label: string;
  /** The field's schema description, when it has one. */
  readonly description: string | undefined;
}

/** Where a document keeps its rows, and the object shapes a row can take. */
export interface TableShape {
  /** The document field holding the row array; null when the document is the array. */
  readonly rowsKey: string | null;
  /** One object schema, or each object option of a union. */
  readonly variants: readonly SchemaLike[];
}

/** A schema that has no single row array, so it cannot be a table. */
export class TableShapeError extends Error {
  public override readonly name = 'TableShapeError';
}

/** The schema under optional, nullable, default and effects wrappers. */
function unwrap(schema: SchemaLike): SchemaLike {
  let current = schema;
  for (;;) {
    const next = current._def.innerType ?? current._def.schema;
    if (next === undefined) return current;
    current = next;
  }
}

function isObject(schema: SchemaLike): boolean {
  return unwrap(schema)._def.typeName === 'ZodObject';
}

function objectShape(schema: SchemaLike): Readonly<Record<string, SchemaLike>> {
  const shape = (unwrap(schema) as { readonly shape?: unknown }).shape;
  return typeof shape === 'object' && shape !== null
    ? (shape as Readonly<Record<string, SchemaLike>>)
    : {};
}

/** The object shapes a row schema allows: itself, or each option of a union of objects. */
function rowVariants(row: SchemaLike): readonly SchemaLike[] {
  const base = unwrap(row);
  if (base._def.typeName === 'ZodObject') return [base];
  const options = base._def.options ?? [];
  const isUnion =
    base._def.typeName === 'ZodUnion' || base._def.typeName === 'ZodDiscriminatedUnion';
  return isUnion && options.length > 0 && options.every(isObject) ? options.map(unwrap) : [];
}

/** The element of an array schema, or undefined. */
function arrayElement(schema: SchemaLike): SchemaLike | undefined {
  const base = unwrap(schema);
  return base._def.typeName === 'ZodArray' ? base._def.type : undefined;
}

/**
 * Finds the rows in a document schema: the document itself when it is an
 * array of objects, otherwise its one field that is an array of objects.
 *
 * @throws {TableShapeError} when there is no such array, or more than one.
 */
export function tableShape(document: SchemaLike): TableShape {
  const element = arrayElement(document);
  if (element !== undefined) {
    const variants = rowVariants(element);
    if (variants.length > 0) return { rowsKey: null, variants };
  }
  const candidates = Object.entries(objectShape(document)).flatMap(([key, field]) => {
    const fieldElement = arrayElement(field);
    const variants = fieldElement === undefined ? [] : rowVariants(fieldElement);
    return variants.length === 0 ? [] : [{ rowsKey: key, variants }];
  });
  const [only, ...others] = candidates;
  if (only === undefined || others.length > 0) {
    throw new TableShapeError(
      `${document.description ?? 'This document'} needs exactly one array of objects to be a table; found ${String(candidates.length)}.`,
    );
  }
  return only;
}

/** The rows of `document` (already validated against its schema). An absent optional array has none. */
export function rowsOf(document: unknown, shape: TableShape): readonly Record<string, unknown>[] {
  const rows =
    shape.rowsKey === null
      ? document
      : (document as Readonly<Record<string, unknown>> | null)?.[shape.rowsKey];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

const ACRONYMS: ReadonlySet<string> = new Set(['id', 'url', 'usd', 'pid', 'llm', 'cli', 'json']);

/** A field name in words: `firstSeenAt` → "First seen at", `totalCostUsd` → "Total cost USD". */
export function humanize(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s_.-]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      return index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
    })
    .join(' ');
}

/**
 * The columns for `rows`, in schema order. A union row shows only the
 * variants present in `rows` (every variant when there are none). A literal
 * field, such as a variant's `kind`, holds the same value in every row, so it
 * is not a column.
 */
export function deriveColumns(shape: TableShape, rows: readonly unknown[] = []): GeneratedColumn[] {
  const present = shape.variants.filter((variant) =>
    rows.some((row) => variant.safeParse(row).success),
  );
  const variants = present.length === 0 ? shape.variants : present;
  const columns = new Map<string, GeneratedColumn>();
  for (const variant of variants) {
    for (const [id, field] of Object.entries(objectShape(variant))) {
      if (columns.has(id) || unwrap(field)._def.typeName === 'ZodLiteral') continue;
      columns.set(id, {
        id,
        label: humanize(id),
        description: field.description ?? unwrap(field).description,
      });
    }
  }
  return [...columns.values()];
}

/**
 * A record document without its envelope. `schemaVersion` and `kind` are
 * protocol plumbing every enveloped `--json` document carries; a bare
 * document (`yantra daemon status --json`) has no `schemaVersion` and is kept
 * whole.
 */
export function recordBody(document: unknown): unknown {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return document;
  }
  if (!Object.hasOwn(document, 'schemaVersion')) return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== 'schemaVersion' && key !== 'kind'),
  );
}

/** Resolves an RFC 6901 JSON pointer inside `value`. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer ${pointer}`);
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (current === null || typeof current !== 'object' || !(key in current))
      throw new Error(`Missing JSON pointer ${pointer}`);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
