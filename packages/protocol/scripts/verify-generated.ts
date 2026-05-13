import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emitJsonSchemas } from '../src/emit/json-schema.js';
import { emitToolCatalog } from '../src/emit/tool-catalog.js';

const readDirectoryFiles = async (directory: string): Promise<Map<string, string>> => {
  const files = await readdir(directory, { withFileTypes: true });
  const map = new Map<string, string>();

  await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(directory, file.name);
      if (file.isDirectory()) {
        const nested = await readDirectoryFiles(absolutePath);
        nested.forEach((value, key) => map.set(path.join(file.name, key), value));
        return;
      }

      map.set(file.name, await readFile(absolutePath, 'utf8'));
    }),
  );

  return map;
};

const compare = (expected: Map<string, string>, actual: Map<string, string>): string[] => {
  const mismatches: string[] = [];
  const keys = new Set([...expected.keys(), ...actual.keys()]);

  keys.forEach((key) => {
    const expectedValue = expected.get(key);
    const actualValue = actual.get(key);

    if (expectedValue !== actualValue) {
      mismatches.push(key);
    }
  });

  return mismatches;
};

const run = async (): Promise<void> => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const generatedRoot = path.join(packageRoot, 'generated');
  const generatedJsonSchemaRoot = path.join(generatedRoot, 'json-schema');

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'yantra-protocol-'));
  const tempGeneratedRoot = path.join(tempRoot, 'generated');
  const tempJsonSchemaRoot = path.join(tempGeneratedRoot, 'json-schema');

  try {
    await emitJsonSchemas(tempJsonSchemaRoot);
    await emitToolCatalog(tempGeneratedRoot);

    const expectedSchemas = await readDirectoryFiles(generatedJsonSchemaRoot);
    const actualSchemas = await readDirectoryFiles(tempJsonSchemaRoot);
    const schemaDiff = compare(expectedSchemas, actualSchemas);

    const expectedCatalog = await readDirectoryFiles(generatedRoot);
    const actualCatalog = await readDirectoryFiles(tempGeneratedRoot);
    const catalogDiff = compare(expectedCatalog, actualCatalog).filter(
      (file) => file === 'tool-catalog.json' || file === 'tool-catalog.ts',
    );

    const mismatches = [...schemaDiff, ...catalogDiff];
    if (mismatches.length > 0) {
      throw new Error(`Generated artifacts drift detected: ${mismatches.join(', ')}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

await run();
