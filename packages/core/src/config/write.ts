import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseDocument, stringify, type Document } from 'yaml';

import { configPath } from '../browser/paths.js';

import { defaultConfig } from './load.js';
import { redactConfigRefs } from './refs.js';
import { configSchema } from './schema.js';

export class ConfigWriteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigWriteError';
  }
}

export async function mutateConfigDocument(
  mutate: (document: Document.Parsed) => void,
  path: string = configPath(),
): Promise<void> {
  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    original = stringify(redactConfigRefs(defaultConfig()));
  }
  const document = parseDocument(original);
  if (document.errors.length > 0) {
    throw new ConfigWriteError(
      `Cannot edit malformed configuration: ${document.errors[0]?.message ?? 'invalid YAML'}`,
    );
  }
  mutate(document);
  const candidate = document.toString();
  const parsed = parseDocument(candidate);
  const validated = configSchema.safeParse(parsed.toJS());
  if (!validated.success) {
    throw new ConfigWriteError(
      validated.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, candidate, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function setConfigKey(path: string, value: unknown, filePath?: string): Promise<void> {
  return mutateConfigDocument((document) => document.setIn(path.split('.'), value), filePath);
}

export function unsetConfigKey(path: string, filePath?: string): Promise<void> {
  return mutateConfigDocument((document) => {
    document.deleteIn(path.split('.'));
  }, filePath);
}
