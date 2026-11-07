import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMAND_REGISTRY } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/program.js';
import { walkCommandTree } from '../registry/walk-tree.js';

import {
  normalize,
  runTerminalScenario,
  runTerminalProcessScenario,
  snapshotTree,
} from './harness.js';
import { actionScenarios } from './scenarios.js';

const baselines = new URL('./baselines/', import.meta.url);
const scenarios = COMMAND_REGISTRY.commands.map((entry) => ({
  id: entry.id,
  argv: [...entry.path, '--help'],
}));

describe('@no-llm pre-migration terminal characterization', () => {
  it('covers every command path in the recursively generated help tree', () => {
    const paths = [...walkCommandTree(buildProgram())]
      .filter((node) => node.kind !== 'root')
      .map((node) => node.path.join(' '));
    expect(scenarios.map((row) => row.argv.slice(0, -1).join(' '))).toEqual(paths);
  });

  it.each(scenarios)('$id retains its terminal baseline', async ({ id, argv }) => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-characterization-'));
    try {
      const actual = await runTerminalScenario({ argv, home });
      const path = new URL(`${id}.json`, baselines);
      if (process.env.CAPTURE_TERMINAL_BASELINES === '1') {
        await mkdir(baselines, { recursive: true });
        await writeFile(path, `${JSON.stringify(actual, null, 2)}\n`);
      }
      const expected: unknown = JSON.parse(await readFile(path, 'utf8'));
      expect(actual).toEqual(expected);
      expect({ ...actual, stderr: `${actual.stderr}changed\n` }).not.toEqual(expected);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('normalizes run identities and times across separate artifact trees', async () => {
    const homes = await Promise.all([1, 2].map(() => mkdtemp(join(tmpdir(), 'yantra-tree-'))));
    try {
      for (const [index, home] of homes.entries()) {
        await writeFile(
          join(home, 'manifest.json'),
          JSON.stringify({
            id: index
              ? 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
              : 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            time: index ? '2026-02-02T01:02:03.000Z' : '2026-01-01T01:02:03.000Z',
            home,
          }),
        );
      }
      expect(await snapshotTree(homes[0]!)).toEqual(await snapshotTree(homes[1]!));
      expect(normalize('unchanged stderr', homes[0]!)).toBe('unchanged stderr');
    } finally {
      await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
    }
  });

  it.concurrent.each(actionScenarios)(
    '%s retains its action baseline',
    async (id, argv) => {
      const home = await mkdtemp(join(tmpdir(), 'yantra-action-'));
      try {
        const actual = await runTerminalProcessScenario({ argv, home });
        const path = new URL(`${id}.json`, baselines);
        if (process.env.CAPTURE_TERMINAL_BASELINES === '1') {
          await mkdir(baselines, { recursive: true });
          await writeFile(path, `${JSON.stringify(actual, null, 2)}\n`);
        }
        expect(actual).toEqual(JSON.parse(await readFile(path, 'utf8')));
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('intercepts process.exit without killing the worker', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-exit-'));
    try {
      const actual = await runTerminalScenario({ argv: ['run', 'missing-workflow'], home });
      expect(actual.exitCode).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
