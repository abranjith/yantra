export interface SchemaLike {
  readonly description?: string | undefined;
  readonly _def: {
    readonly typeName?: string;
    readonly innerType?: SchemaLike;
    readonly schema?: SchemaLike;
  };
  readonly shape?: Readonly<Record<string, SchemaLike>> | undefined;
  safeParse(value: unknown): { readonly success: boolean };
}

export interface GeneratedColumn {
  readonly id: string;
  readonly label: string;
  readonly nested: boolean;
}

function objectShape(schema: SchemaLike): Readonly<Record<string, SchemaLike>> {
  const def = schema._def;
  if (def.innerType !== undefined) return objectShape(def.innerType);
  if (def.schema !== undefined) return objectShape(def.schema);
  if ('shape' in schema && typeof (schema as { shape?: unknown }).shape === 'object')
    return (schema as { shape: Readonly<Record<string, SchemaLike>> }).shape;
  return {};
}

export function deriveColumns(schema: SchemaLike): GeneratedColumn[] {
  return Object.entries(objectShape(schema)).map(([id, value]) => ({
    id,
    label: value.description ?? id,
    nested: value._def.typeName === 'ZodObject' || value._def.typeName === 'ZodArray',
  }));
}

export function rowsFromEnvelope(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['rows', 'items', 'preferences'])
      if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

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
