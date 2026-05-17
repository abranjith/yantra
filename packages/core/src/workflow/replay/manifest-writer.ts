/**
 * Atomic manifest and outputs writer.
 *
 * Uses the tmp-then-rename pattern to ensure atomicity:
 *   write to `<file>.tmp` → fsync → rename to `<file>`
 *
 * This matches FEAT-009's workflow YAML write convention.
 */

import { rename, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunManifest, RunOutputs } from './types.js';

const MANIFEST_FILE = 'manifest.json';
const OUTPUTS_FILE = 'outputs.json';

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

/**
 * Atomically writes the run manifest to `<runDir>/manifest.json`.
 */
export async function writeManifest(runDir: string, manifest: RunManifest): Promise<void> {
  const path = join(runDir, MANIFEST_FILE);
  await atomicWrite(path, JSON.stringify(manifest, null, 2));
}

/**
 * Reads and parses `<runDir>/manifest.json`.
 */
export async function readManifest(runDir: string): Promise<RunManifest> {
  const path = join(runDir, MANIFEST_FILE);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as RunManifest;
}

// ---------------------------------------------------------------------------
// outputs.json
// ---------------------------------------------------------------------------

/**
 * Atomically writes `<runDir>/outputs.json`.
 */
export async function writeOutputs(runDir: string, outputs: RunOutputs): Promise<void> {
  const path = join(runDir, OUTPUTS_FILE);
  await atomicWrite(path, JSON.stringify(outputs, null, 2));
}

// ---------------------------------------------------------------------------
// params redaction
// ---------------------------------------------------------------------------

/**
 * Walks a params record and replaces any value whose key appears in
 * `declaredSecretKeys` with a redacted sentinel.
 *
 * Params are not secrets by design — if a secret key somehow ends up as a
 * param key, this defense-in-depth pass removes it from the on-disk manifest.
 */
export function redactParamsForManifest(
  params: Readonly<Record<string, unknown>>,
  declaredSecretKeys: readonly string[],
): Record<string, unknown> {
  const secretKeySet = new Set(declaredSecretKeys);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (secretKeySet.has(key)) {
      result[key] = { kind: 'secret', key };
    } else if (
      value !== null &&
      typeof value === 'object' &&
      'kind' in value &&
      (value as { kind: string }).kind === 'secret'
    ) {
      // Already a SecretRef shape — pass through as-is
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}
