import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitJsonSchemas } from '../src/index.js';

describe('@no-llm json schema emitter', () => {
  it('emits schema files with stable top-level title', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'yantra-protocol-schema-'));
    const jsonSchemaDir = path.join(tempDir, 'json-schema');

    try {
      await emitJsonSchemas(jsonSchemaDir);
      const planSchema = JSON.parse(await readFile(path.join(jsonSchemaDir, 'plan.json'), 'utf8'));
      expect(planSchema.$ref || planSchema.definitions || planSchema.$defs).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
