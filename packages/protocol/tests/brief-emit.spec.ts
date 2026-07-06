import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitJsonSchemas } from '../src/index.js';

type JsonSchemaObject = Record<string, unknown>;

const asObject = (value: unknown): JsonSchemaObject => {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  return value as JsonSchemaObject;
};

describe('@no-llm brief json schema emission', () => {
  it('emits brief.schema.json as valid draft-07 JSON Schema with citation structure', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'yantra-brief-schema-'));

    try {
      await emitJsonSchemas(tempDir);
      const raw = await readFile(path.join(tempDir, 'brief.schema.json'), 'utf8');
      const emitted = asObject(JSON.parse(raw));

      expect(emitted['$schema']).toContain('json-schema.org/draft-07');
      expect(emitted['$ref']).toBe('#/definitions/Brief');

      const brief = asObject(asObject(emitted['definitions'])['Brief']);
      expect(brief['type']).toBe('object');
      expect(brief['required']).toContain('sources');
      expect(brief['required']).toContain('overview');

      const properties = asObject(brief['properties']);
      const keyFindings = asObject(properties['key_findings']);
      const keyFindingItem = asObject(keyFindings['items']);
      const keyFindingProps = asObject(keyFindingItem['properties']);
      expect(keyFindingProps['citations']).toBeDefined();
      expect(keyFindingProps['editorial']).toBeDefined();

      const sources = asObject(properties['sources']);
      const sourceItem = asObject(sources['items']);
      const sourceProps = asObject(sourceItem['properties']);
      expect(sourceProps['n']).toBeDefined();
      expect(sourceProps['final_url']).toBeDefined();

      expect(emitted).toMatchSnapshot();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
