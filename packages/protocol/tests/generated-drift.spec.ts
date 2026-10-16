import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitJsonSchemas } from '../src/index.js';

const GENERATED_JSON_SCHEMA_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  'generated',
  'json-schema',
);

/** Reads every file in `directory`, normalizing line endings so a CRLF checkout compares equal. */
async function readSchemas(directory: string): Promise<Map<string, string>> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          (await readFile(path.join(directory, name), 'utf8')).replace(/\r\n/g, '\n'),
        ] as const,
    ),
  );
  return new Map(entries);
}

describe('@no-llm generated JSON Schema drift', () => {
  it('matches what the Zod schemas emit today (run the protocol emit script after a change)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yantra-protocol-drift-'));
    try {
      await emitJsonSchemas(dir);
      const emitted = await readSchemas(dir);
      const committed = await readSchemas(GENERATED_JSON_SCHEMA_ROOT);
      expect([...committed.keys()]).toEqual([...emitted.keys()]);
      for (const [name, content] of emitted) {
        expect({ name, content: committed.get(name) }).toEqual({ name, content });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
