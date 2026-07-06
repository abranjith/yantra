import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import * as Protocol from '../index.js';

const isZodSchema = (value: unknown): value is z.ZodTypeAny =>
  typeof value === 'object' &&
  value !== null &&
  '_def' in value &&
  typeof (value as { parse?: unknown }).parse === 'function';

const escapeTableCell = (value: string): string => value.replace(/\|/g, '\\|');

/** Unwraps refinement/transform wrappers so superRefined objects still render field tables. */
const unwrapEffects = (schema: z.ZodTypeAny): z.ZodTypeAny =>
  schema instanceof z.ZodEffects ? unwrapEffects(schema.innerType() as z.ZodTypeAny) : schema;

const renderFieldTable = (wrapped: z.ZodTypeAny): string => {
  const schema = unwrapEffects(wrapped);
  if (!(schema instanceof z.ZodObject)) {
    return '';
  }

  const shape = schema.shape as unknown as Record<string, z.ZodTypeAny>;
  const rows = Object.entries(shape).map(
    ([key, value]) => [escapeTableCell(key), escapeTableCell(value.description ?? '')] as const,
  );

  if (rows.length === 0) {
    return '';
  }

  const header = ['Field', 'Description'] as const;
  const [fieldWidth, descriptionWidth] = rows.reduce(
    ([currentFieldWidth, currentDescriptionWidth], [field, description]) => [
      Math.max(currentFieldWidth, field.length),
      Math.max(currentDescriptionWidth, description.length),
    ],
    [header[0].length, header[1].length],
  );

  const formatRow = ([field, description]: readonly [string, string]): string =>
    `| ${field.padEnd(fieldWidth)} | ${description.padEnd(descriptionWidth)} |`;

  return [
    formatRow(header),
    `| ${'-'.repeat(fieldWidth)} | ${'-'.repeat(descriptionWidth)} |`,
    ...rows.map((row) => formatRow(row)),
  ].join('\n');
};

const toExample = (wrapped: z.ZodTypeAny): string => {
  const schema = unwrapEffects(wrapped);
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as unknown as Record<string, z.ZodTypeAny>;
    const exampleObject = Object.fromEntries(Object.keys(shape).map((key) => [key, `<${key}>`]));
    return JSON.stringify(exampleObject, null, 2);
  }

  if (schema instanceof z.ZodEnum) {
    const options = schema.options as unknown as string[];
    return JSON.stringify(options[0] ?? null, null, 2);
  }

  return JSON.stringify('<value>', null, 2);
};

export const emitProtocolSpecDoc = async (repositoryRoot: string): Promise<void> => {
  const outputPath = path.join(repositoryRoot, 'docs', 'protocol-spec.md');
  await mkdir(path.dirname(outputPath), { recursive: true });

  const sections = Object.entries(Protocol)
    .filter(([, value]) => isZodSchema(value))
    .map(([name, value]) => {
      const schema = value as z.ZodTypeAny;
      const description = schema.description ?? 'No description provided.';
      const fields = renderFieldTable(schema);
      const example = toExample(schema);

      const lines = [`## ${name}`, '', description, ''];
      if (fields !== '') {
        lines.push(fields, '');
      }

      lines.push('Example:', '', '```json', example, '```', '');

      return lines.join('\n');
    });

  const body = [
    '# Protocol Spec',
    '',
    '> DO NOT EDIT - regenerated from packages/protocol',
    '',
    `Current schema version: **${Protocol.SCHEMA_VERSION}**. Accepted versions: ${Protocol.SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
    'The 0.2 bump is additive: it introduces the Brief document type; Plan and workflow contracts are unchanged and 0.1 documents remain valid.',
    '',
    ...sections,
  ].join('\n');

  await writeFile(outputPath, `${body}\n`, 'utf8');
};
