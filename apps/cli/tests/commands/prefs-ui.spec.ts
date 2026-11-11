// @no-llm
/**
 * `ui.theme` and `ui.surfaces` through the real commands (FEAT-065 TASK-009):
 * `prefs set/get`, the `config set` redirect, and `read.prefs.list`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { dataDir, resetPathCache } from '@yantra/core';
import { ReadParams, type ReadResult } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../src/execute.js';
import { keyOwner } from '../../src/key-ownership.js';
import { registerReads } from '../../src/ui/host/reads.js';
import { RpcMethodRegistry, type RpcCallContext } from '../../src/ui/host/rpc-server.js';

let home: string;

async function run(
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const context = createTerminalContext({
    env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
    cwd: home,
    isTty: false,
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        stdout += String(chunk);
        callback();
      },
    }),
    stderr: new Writable({
      write(chunk, _encoding, callback) {
        stderr += String(chunk);
        callback();
      },
    }),
  });
  const result = await executeCommand(argv, context);
  return { code: result.exitCode, stdout, stderr };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-prefs-ui-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

describe('prefs', () => {
  it('persists ui.theme dark and reads it back', async () => {
    expect((await run(['prefs', 'set', 'ui.theme', 'dark'])).code).toBe(0);
    const got = await run(['prefs', 'get', 'ui.theme']);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain('dark');
  });

  it('applies the defaults in the effective profile when the keys are absent', async () => {
    const profile = await run(['profile', '--json']);
    const rows = (JSON.parse(profile.stdout) as { preferences: { key: string; value: unknown }[] })
      .preferences;
    expect(rows.find((row) => row.key === 'ui.theme')?.value).toBe('system');
    expect(rows.find((row) => row.key === 'ui.surfaces')?.value).toBe('glass');
  });

  it('rejects an invalid value with exit 1 and lists the valid values', async () => {
    const result = await run(['prefs', 'set', 'ui.surfaces', 'frosted']);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/glass.*solid/u);
  });

  it('treats ui.density as an unknown key', async () => {
    const result = await run(['prefs', 'set', 'ui.density', 'compact']);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('unknown preference key "ui.density"');
  });
});

describe('ownership', () => {
  it('belongs to prefs', () => {
    expect(keyOwner('ui.theme')).toBe('prefs');
    expect(keyOwner('ui.surfaces')).toBe('prefs');
  });

  it('makes config set ui.theme redirect to prefs by name', async () => {
    const result = await run(['config', 'set', 'ui.theme', 'dark']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('yantra prefs set ui.theme');
  });
});

function reader(method: string) {
  const methods = new RpcMethodRegistry();
  registerReads(methods, { env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' }, cwd: dataDir() });
  return async (params: unknown = {}): Promise<ReadResult> =>
    (await methods.get(method)!.handler(ReadParams.parse(params), {
      windowId: 'w',
      connection: {},
    } as unknown as RpcCallContext)) as ReadResult;
}

describe('read.profile', () => {
  it('reports both keys with their effective values and sources, including a hand-edited profile.yaml', async () => {
    // Arrange: theme edited by hand, surfaces left to the default.
    await writeFile(join(home, 'profile.yaml'), ['ui:', '  theme: dark', ''].join('\n'));

    // Act
    const result = await reader('read.profile')();

    // Assert
    const rows = (
      result.value as { preferences: { key: string; value: unknown; provenance: string }[] }
    ).preferences;
    expect(rows.find((row) => row.key === 'ui.theme')).toMatchObject({
      value: 'dark',
      provenance: 'profile.yaml',
    });
    expect(rows.find((row) => row.key === 'ui.surfaces')).toMatchObject({ value: 'glass' });
  });
});

describe('read.prefs.list', () => {
  it('includes both keys with their sources once stored', async () => {
    // Arrange
    await run(['prefs', 'set', 'ui.theme', 'light']);
    await run(['prefs', 'set', 'ui.surfaces', 'solid']);

    // Act
    const result = await reader('read.prefs.list')();

    // Assert
    const text = JSON.stringify(result.value);
    expect(text).toContain('ui.theme');
    expect(text).toContain('ui.surfaces');
    expect(text).toContain('solid');
    expect(text).toContain('"source":"user"');
  });
});
