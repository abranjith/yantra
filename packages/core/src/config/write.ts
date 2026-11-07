import { readFile } from 'node:fs/promises';

import { parseDocument, stringify, type Document } from 'yaml';

import { configPath } from '../browser/paths.js';
import { writeFileAtomic } from '../fs/atomic-write.js';
import { withResourceLock, type ResourceLockOptions } from '../locks/resource-lock.js';

import { defaultConfig, loadConfig } from './load.js';
import { redactConfigRefs } from './refs.js';
import { configSchema, type YantraConfig } from './schema.js';

export class ConfigWriteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigWriteError';
  }
}

async function editConfigDocument(
  mutate: (document: Document.Parsed) => void | Promise<void>,
  path: string,
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
  await mutate(document);
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
  await writeFileAtomic(path, candidate, { mode: 0o600 });
}

/** Read, edit, validate and publish YAML while holding the shared config lock. */
export async function mutateConfigDocument(
  mutate: (document: Document.Parsed) => void | Promise<void>,
  path: string = configPath(),
  options: ResourceLockOptions = {},
): Promise<void> {
  await withResourceLock({ kind: 'config' }, () => editConfigDocument(mutate, path), {
    ...options,
    targetPath: path,
  });
}

/** Whole-file write for initialization and validated raw-YAML editing. */
export async function writeConfigDocument(
  text: string,
  path: string = configPath(),
  options: ResourceLockOptions = {},
): Promise<void> {
  await withResourceLock(
    { kind: 'config' },
    async () => {
      const parsed = parseDocument(text);
      if (parsed.errors.length)
        throw new ConfigWriteError(
          `Cannot write malformed configuration: ${parsed.errors[0]?.message ?? 'invalid YAML'}`,
        );
      const validated = configSchema.safeParse(parsed.toJS() ?? {});
      if (!validated.success)
        throw new ConfigWriteError(
          validated.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
        );
      await writeFileAtomic(path, text, { mode: 0o600 });
    },
    { ...options, targetPath: path },
  );
}

/** Parsed configuration mutation; the authoritative read happens inside the lock. */
export async function mutateConfig(
  mutate: (current: YantraConfig) => YantraConfig | Promise<YantraConfig>,
  path: string = configPath(),
  options: ResourceLockOptions = {},
): Promise<void> {
  await withResourceLock(
    { kind: 'config' },
    async () => {
      // Reuse the public loader's actionable errors, now inside the lock.
      const loaded = await loadConfig(path);
      if (!loaded.isOk) throw loaded.error;
      const before = redactConfigRefs(loaded.value) as Record<string, unknown>;
      const next = await mutate(loaded.value);
      const after = redactConfigRefs(next) as Record<string, unknown>;
      await editConfigDocument((document) => {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
          if (after[key] === undefined) document.delete(key);
          else document.set(key, after[key]);
        }
      }, path);
    },
    { ...options, targetPath: path },
  );
}

export function setConfigKey(path: string, value: unknown, filePath?: string): Promise<void> {
  return mutateConfigDocument((document) => document.setIn(path.split('.'), value), filePath);
}

export function unsetConfigKey(path: string, filePath?: string): Promise<void> {
  return mutateConfigDocument((document) => {
    document.deleteIn(path.split('.'));
  }, filePath);
}
