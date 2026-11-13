/**
 * Run-directory fixture builders for the run-view suites (FEAT-066) and the
 * app end-to-end suite. Vitest-free on purpose: `tsx` scripts and e2e specs
 * import this module directly (memory -> Testing: `@yantra/test-helpers`
 * loads Vitest at import time).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The contents of one run directory. */
export interface RunDirSpec {
  readonly runId: string;
  /** An object is written as JSON; a string is written verbatim (e.g. corrupt); null writes none. */
  readonly manifest?: Readonly<Record<string, unknown>> | string | null;
  /** Run-relative paths (forward slashes) and their contents. */
  readonly files?: Readonly<Record<string, string | Buffer | Readonly<Record<string, unknown>>>>;
}

/** An ISO instant `seconds` after 2026-11-01T00:00:00Z. */
export function fixtureInstant(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + seconds * 1000).toISOString();
}

/** A `formatRunId`-shaped id that starts at {@link fixtureInstant}(`seconds`). */
export function fixtureRunId(seconds: number, name = 'fixture', suffix = 'a7b3c9d1'): string {
  const compact = fixtureInstant(seconds)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${compact}-${name}-${suffix}`;
}

/** A workflow `RunManifest` (the shape `LocalRunStore` writes). */
export function workflowManifest(
  runId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const startedAt =
    typeof overrides.startedAt === 'string' ? overrides.startedAt : fixtureInstant(0);
  return {
    runId,
    taskId: '01J00000000000000000000000',
    workflowName: 'fixture',
    workflowVersion: 1,
    status: 'completed',
    startedAt,
    endedAt: startedAt,
    durationMs: 1000,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    params: {},
    outputBindingNames: [],
    ...overrides,
  };
}

/** An agentic (`ask`/`research`/`do`) manifest in the workflow shape (`runKind: agentic`). */
export function agenticManifest(
  runId: string,
  mode: 'ask' | 'research' | 'do',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return workflowManifest(runId, { workflowName: mode, runKind: 'agentic', ...overrides });
}

/** Writes one run directory under `runsDir` and returns its path. */
export async function buildRunDir(runsDir: string, spec: RunDirSpec): Promise<string> {
  const dir = join(runsDir, spec.runId);
  await mkdir(dir, { recursive: true });
  const manifest = spec.manifest === undefined ? workflowManifest(spec.runId) : spec.manifest;
  if (manifest !== null) {
    await writeFile(
      join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    );
  }
  for (const [path, content] of Object.entries(spec.files ?? {})) {
    const target = join(dir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof content === 'string' || Buffer.isBuffer(content)
        ? content
        : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

/** JSON Lines text from records. */
export function jsonl(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}
