import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath, FileDaemonLock, loadConfig, resetPathCache } from '@yantra/core';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeConfigCommand,
  moveDirectory,
  type MoveDirectoryDependencies,
} from '../../src/commands/config.js';

describe('@no-llm config command', () => {
  let root: string;
  let savedEnv: Record<string, string | undefined>;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-config-command-'));
    savedEnv = {
      YANTRA_HOME: process.env.YANTRA_HOME,
      YANTRA_DATA_DIR: process.env.YANTRA_DATA_DIR,
      YANTRA_CACHE_DIR: process.env.YANTRA_CACHE_DIR,
      EDITOR: process.env.EDITOR,
    };
    process.env.YANTRA_HOME = root;
    delete process.env.YANTRA_DATA_DIR;
    delete process.env.YANTRA_CACHE_DIR;
    resetPathCache();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<void> {
    await makeConfigCommand()
      .exitOverride()
      .parseAsync([...args], { from: 'user' });
  }

  it('reports every resolved location and its environment/config source', async () => {
    await run(['set', 'paths.data_dir', join(root, 'configured-data')]);
    process.env.YANTRA_CACHE_DIR = join(root, 'environment-cache');
    resetPathCache();
    stdout = [];
    await run(['path', '--json']);
    const result = JSON.parse(stdout.join('')) as {
      readonly rows: readonly { readonly name: string; readonly source: string }[];
    };
    expect(result.rows.map((row) => row.name)).toEqual([
      'home',
      'config',
      'profile',
      'data',
      'cache',
      'runs',
      'workflows',
      'templates',
      'index.db',
    ]);
    expect(result.rows.find((row) => row.name === 'home')?.source).toBe('env:YANTRA_HOME');
    expect(result.rows.find((row) => row.name === 'data')?.source).toBe('config:paths.data_dir');
    expect(result.rows.find((row) => row.name === 'cache')?.source).toBe('env:YANTRA_CACHE_DIR');
  });

  it('preserves comments and order, rejects invalid writes byte-for-byte, and unsets to defaults', async () => {
    await writeFile(configPath(), '# keep me\nversion: 1\nretention:\n  runs_days: 30\n');
    await run(['set', 'retention.runs_days', '7']);
    const valid = await readFile(configPath(), 'utf8');
    expect(valid).toContain('# keep me');
    expect(valid.indexOf('version:')).toBeLessThan(valid.indexOf('retention:'));
    expect(valid).toContain('runs_days: 7');
    await expect(run(['set', 'retention.runs_days', '-1'])).rejects.toBeInstanceOf(CommanderError);
    expect(await readFile(configPath(), 'utf8')).toBe(valid);
    await run(['unset', 'retention.runs_days']);
    const loaded = await loadConfig();
    expect(loaded.isOk && loaded.value.retention.runs_days).toBe(30);
  });

  it('renders references without resolving them and redirects profile-owned keys', async () => {
    await run(['set', 'search.tavily.api_key', '${env:TAVILY_API_KEY}']);
    stdout = [];
    await run(['get', 'search.tavily.api_key']);
    expect(stdout.join('')).toContain('${env:TAVILY_API_KEY}');
    await expect(run(['set', 'defaults.detail', 'full'])).rejects.toBeInstanceOf(CommanderError);
    expect(stderr.join('')).toContain('yantra prefs set defaults.detail full');
  });

  it('restores the original bytes when an editor writes invalid YAML', async () => {
    const original = '# original\nversion: 1\n';
    await writeFile(configPath(), original);
    const editor = join(
      root,
      process.platform === 'win32' ? 'invalid-editor.cmd' : 'invalid-editor.sh',
    );
    const script =
      process.platform === 'win32'
        ? '@echo off\r\n> "%~1" echo paths: [\r\n'
        : '#!/bin/sh\nprintf "paths: [" > "$1"\n';
    await writeFile(editor, script);
    if (process.platform !== 'win32') await chmod(editor, 0o700);
    process.env.EDITOR = editor;
    await expect(run(['edit'])).rejects.toBeInstanceOf(CommanderError);
    expect(await readFile(configPath(), 'utf8')).toBe(original);
  });

  it('supports dry-run and no-move relocation without touching source content', async () => {
    const sourceMarker = join(root, 'data', 'marker.txt');
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(sourceMarker, 'source');
    const target = join(root, 'relocated');
    const before = await readFile(configPath(), 'utf8').catch(() => '');
    await run(['data-dir', target, '--dry-run']);
    expect(await readFile(configPath(), 'utf8').catch(() => '')).toBe(before);
    await run(['data-dir', target, '--no-move']);
    expect(await readFile(sourceMarker, 'utf8')).toBe('source');
    const loaded = await loadConfig();
    expect(loaded.isOk && loaded.value.paths.data_dir).toBe(target);
  });

  it('copies across volumes and removes the source only after a successful copy', async () => {
    const order: string[] = [];
    const dependencies = {
      stat: vi.fn(async () => ({}) as never),
      mkdir: vi.fn(async () => undefined),
      rename: vi.fn(async () => {
        throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' });
      }),
      cp: vi.fn(async () => {
        order.push('copy');
      }),
      rm: vi.fn(async () => {
        order.push('remove');
      }),
    } as unknown as MoveDirectoryDependencies;
    await moveDirectory('C:\\source', 'D:\\target', false, dependencies);
    expect(order).toEqual(['copy', 'remove']);
  });

  it('leaves the source intact and reports execution failure when a cross-volume copy fails', async () => {
    const dependencies = {
      stat: vi.fn(async () => ({}) as never),
      mkdir: vi.fn(async () => undefined),
      rename: vi.fn(async () => {
        throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' });
      }),
      cp: vi.fn(async () => {
        throw new Error('interrupted');
      }),
      rm: vi.fn(async () => undefined),
    } as unknown as MoveDirectoryDependencies;
    await expect(
      moveDirectory('C:\\source', 'D:\\target', false, dependencies),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(dependencies.rm).not.toHaveBeenCalled();
  });

  it('rejects relative and non-empty relocation targets without changing config', async () => {
    await expect(run(['data-dir', 'relative/path'])).rejects.toBeInstanceOf(CommanderError);
    const target = join(root, 'occupied');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'keep');
    const before = await readFile(configPath(), 'utf8').catch(() => '');
    await expect(run(['data-dir', target])).rejects.toBeInstanceOf(CommanderError);
    expect(await readFile(configPath(), 'utf8').catch(() => '')).toBe(before);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses relocation while the daemon lock is held and names its PID', async () => {
    const release = await new FileDaemonLock().acquire(4242);
    try {
      await expect(run(['data-dir', join(root, 'locked-target')])).rejects.toBeInstanceOf(
        CommanderError,
      );
      expect(stderr.join('')).toContain('pid 4242');
    } finally {
      await release();
    }
  });

  it('merges into a non-empty target only with --force', async () => {
    const source = join(root, 'data');
    const target = join(root, 'force-target');
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'from-source.txt'), 'source');
    await writeFile(join(target, 'already-there.txt'), 'target');
    await run(['data-dir', target, '--force']);
    expect(await readFile(join(target, 'from-source.txt'), 'utf8')).toBe('source');
    expect(await readFile(join(target, 'already-there.txt'), 'utf8')).toBe('target');
    await expect(readFile(join(source, 'from-source.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
