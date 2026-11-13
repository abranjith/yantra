import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { Command } from 'commander';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/program.js';

import {
  captureCliSurface,
  compareSurface,
  errorCasesFor,
  runCase,
  unifiedDiff,
  type SurfaceFile,
} from './surface.js';
import { listCommands, pathFileName } from './walk-tree.js';

const fixtureRoot = resolve(import.meta.dirname, '..', 'fixtures', 'cli-surface');

async function readGoldens(): Promise<Map<string, string>> {
  const entries = await readdir(fixtureRoot, { recursive: true, withFileTypes: true });
  const goldens = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    goldens.set(
      relative(fixtureRoot, absolute).split(sep).join('/'),
      await readFile(absolute, 'utf8'),
    );
  }
  return goldens;
}

describe('@no-llm CLI surface characterization', () => {
  let goldens: Map<string, string>;
  let captured: readonly SurfaceFile[];

  beforeAll(async () => {
    goldens = await readGoldens();
    captured = await captureCliSurface(() => buildProgram());
  }, 180_000);

  it('rebuilds every golden byte for byte from buildProgram', () => {
    // Arrange: goldens and the fresh capture are loaded once in beforeAll.
    // Act
    const mismatches = compareSurface(captured, goldens);

    // Assert: on failure the report lists every mismatch, then the first diff.
    const first = mismatches[0];
    const report =
      first === undefined
        ? []
        : [
            ...mismatches.map((mismatch) => `${mismatch.kind}: ${mismatch.relativePath}`),
            `first difference:\n${first.diff}`,
          ];
    expect(report).toEqual([]);
  });

  it('holds goldens for every help width, error case and the version', () => {
    expect(goldens.has('version.txt')).toBe(true);
    expect(goldens.has('help/w80/root.txt')).toBe(true);
    expect(goldens.has('help/w160/root.txt')).toBe(true);
    expect(goldens.has('errors/root.unknown-command.json')).toBe(true);
    expect(goldens.get('version.txt')).toMatch(/^\d+\.\d+\.\d+ \(yantra cli\)\n$/);
  });

  it('never reaches a leaf action in any characterized case', () => {
    const invoked = [...goldens.entries()].filter(
      ([path, content]) => path.startsWith('errors/') && content.includes('"action-invoked"'),
    );
    expect(invoked.map(([path]) => path)).toEqual([]);
  });

  it('prints the do golden for the discover alias', async () => {
    const outcome = await runCase(() => buildProgram(), ['discover', '--help'], 80);
    expect(outcome.stdout).toBe(goldens.get('help/w80/do.txt'));
  });

  it('stores goldens LF-only with no control bytes other than newline', () => {
    const offenders = [...goldens.entries()]
      .filter(([, content]) => [...content].some((char) => char < ' ' && char !== '\n'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe('@no-llm surface comparison harness', () => {
  function testProgram(description: string): Command {
    const program = new Command().name('yantra').exitOverride();
    program
      .command('probe')
      .description(description)
      .argument('<thing>', 'a thing')
      .option('--json', 'emit JSON', false)
      .action(() => undefined);
    return program;
  }

  it('fails the comparison when a description changes, with a unified diff', async () => {
    // Arrange
    const golden = await captureCliSurface(() => testProgram('Original description'));
    const goldenMap = new Map(golden.map((file) => [file.relativePath, file.content]));

    // Act
    const changed = await captureCliSurface(() => testProgram('Changed description'));
    const mismatches = compareSurface(changed, goldenMap);

    // Assert
    expect(mismatches.length).toBeGreaterThan(0);
    const probeHelp = mismatches.find((mismatch) => mismatch.relativePath === 'help/w80/probe.txt');
    expect(probeHelp?.kind).toBe('changed');
    expect(probeHelp?.diff).toContain('-Original description');
    expect(probeHelp?.diff).toContain('+Changed description');
  });

  it('reports goldens with no capture and captures with no golden', () => {
    const mismatches = compareSurface(
      [{ relativePath: 'a.txt', content: 'x' }],
      new Map([['b.txt', 'y']]),
    );
    expect(mismatches).toEqual([
      { relativePath: 'a.txt', kind: 'missing-golden', diff: '' },
      { relativePath: 'b.txt', kind: 'missing-capture', diff: '' },
    ]);
  });

  it('passes when capture and goldens agree exactly', async () => {
    const files = await captureCliSurface(() => testProgram('Same'));
    expect(compareSurface(files, new Map(files.map((f) => [f.relativePath, f.content])))).toEqual(
      [],
    );
  });

  it('renders added, removed and kept lines in a unified diff', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nB\nc', 'x.txt').split('\n')).toEqual([
      '--- golden/x.txt',
      '+++ actual/x.txt',
      ' a',
      '+B',
      '-b',
      ' c',
    ]);
  });

  it('records a parse that reaches an action instead of running it', async () => {
    const outcome = await runCase(() => testProgram('d'), ['probe', 'value'], 80);
    expect(outcome.code).toBe('action-invoked');
    expect(outcome.exitCode).toBe(-1);
  });
});

describe('@no-llm command tree walker', () => {
  const nodes = listCommands(buildProgram());

  it('finds 60 command paths: 7 groups and 53 leaves', () => {
    const commands = nodes.filter((node) => node.kind !== 'root');
    expect(commands).toHaveLength(60);
    expect(commands.filter((node) => node.kind === 'group')).toHaveLength(7);
    expect(commands.filter((node) => node.kind === 'leaf')).toHaveLength(53);
  });

  it('yields the root first and then registration order, depth first', () => {
    expect(nodes[0]?.kind).toBe('root');
    expect(nodes.slice(1, 5).map((node) => node.path.join(' '))).toEqual([
      'ask',
      'research',
      'do',
      'run',
    ]);
    const configIndex = nodes.findIndex((node) => node.path.join(' ') === 'config');
    expect(nodes[configIndex + 1]?.path).toEqual(['config', 'path']);
  });

  it('gives every path a unique file name', () => {
    const names = nodes.map((node) => pathFileName(node.path));
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes aliases, arguments and options through the public API', () => {
    const doNode = nodes.find((node) => node.path.join(' ') === 'do');
    expect(doNode?.aliases).toEqual(['discover']);
    expect(doNode?.arguments.map((argument) => argument.name())).toEqual(['goal']);
    expect(doNode?.options.some((option) => option.long === '--allow-host')).toBe(true);
  });

  it('supplies mandatory options so missing-argument is reachable', () => {
    const schedule = nodes.find((node) => node.path.join(' ') === 'schedule');
    expect(schedule).toBeDefined();
    const cases = errorCasesFor(schedule!);
    expect(cases.find((c) => c.name === 'missing-argument')?.argv).toEqual([
      'schedule',
      '--cron',
      'value',
    ]);
  });
});
