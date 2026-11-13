// @no-llm
/**
 * `yantra list` on the shared Ledger query (FEAT-066 TASK-002), as a
 * characterization test: the goldens under `__goldens__/list-ledger/` were
 * captured from the pre-FEAT-066 `list` implementation on this exact fixture
 * tree. Terminal output and stderr must stay byte-identical; `--json` output
 * must equal the golden plus only the additive optional keys.
 *
 * Recapture deliberately with `YANTRA_CAPTURE_LIST_GOLDENS=1`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type * as CoreModule from '@yantra/core';
import { dataDir, resetPathCache, runsRoot, workflowsRoot, type HistoryEntry } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type * as HistoryModule from '../../src/history.js';
import { openHistory } from '../../src/history.js';

/** When true, `openHistory` reports the index unavailable (the file-scan path). */
let indexOff = false;

vi.mock('../../src/history.js', async (importActual) => {
  const actual = await importActual<typeof HistoryModule>();
  return {
    ...actual,
    openHistory: (...args: Parameters<typeof actual.openHistory>) =>
      indexOff ? Promise.resolve(null) : actual.openHistory(...args),
  };
});

vi.mock('@yantra/core', async (importActual) => ({
  ...(await importActual<typeof CoreModule>()),
  createKeychainProvider: () =>
    Promise.resolve({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      isAvailable: () => Promise.resolve(false),
    }),
}));

const GOLDENS = join(import.meta.dirname, '__goldens__', 'list-ledger');
const CAPTURE = process.env.YANTRA_CAPTURE_LIST_GOLDENS === '1';
const ADDITIVE_KEYS = ['taskType', 'costUsd', 'hasDocument'] as const;

const WORKFLOW =
  'version: 1\nname: fixture\ndescription: Ledger fixture\nsecurity_class: public\nparams: {}\nsecrets: []\ncookies: none\nsteps:\n  - id: s1\n    verb: navigate\n    url: https://fixture.example\n    scope: null\noutputs: []\n';

let home: string;

function at(second: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
}

function runId(second: number, name: string): string {
  return `${at(second)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}-${name}-0000abcd`;
}

async function writeRun(
  id: string,
  manifest: Readonly<Record<string, unknown>> | string,
  files: Readonly<Record<string, string>> = {},
): Promise<void> {
  const dir = join(runsRoot(), id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
}

function workflowManifest(
  id: string,
  second: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    runId: id,
    taskId: '01J00000000000000000000000',
    workflowName: 'fixture',
    workflowVersion: 1,
    status: 'completed',
    startedAt: at(second),
    endedAt: at(second + 2),
    durationMs: 2000,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    params: {},
    outputBindingNames: [],
    ...overrides,
  };
}

function entry(id: string, second: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    runId: id,
    taskType: 'ask',
    intentText: `question ${second}`,
    briefId: null,
    status: 'succeeded',
    startedAt: at(second),
    finishedAt: at(second + 1),
    durationMs: 1000,
    costUsd: null,
    provider: null,
    taskOutcome: null,
    ...overrides,
  };
}

/** How the history index is set up for a case. */
type IndexMode = 'index' | 'rebuilt-index' | 'no-index';

/** The fixture tree every case lists. */
async function seed(mode: IndexMode): Promise<void> {
  await mkdir(workflowsRoot(), { recursive: true });
  await writeFile(join(workflowsRoot(), 'fixture.yaml'), WORKFLOW);
  // A fixed mtime, so `modifiedAt` is stable across runs.
  const fixed = new Date(Date.UTC(2026, 10, 1));
  await utimes(join(workflowsRoot(), 'fixture.yaml'), fixed, fixed);

  await writeRun(runId(10, 'fixture'), workflowManifest(runId(10, 'fixture'), 10));
  await writeRun(
    runId(20, 'fixture'),
    workflowManifest(runId(20, 'fixture'), 20, { status: 'failed', taskOutcome: 'failed' }),
  );
  await writeRun(
    runId(30, 'other'),
    workflowManifest(runId(30, 'other'), 30, {
      workflowName: 'other',
      status: 'paused',
      taskOutcome: 'handoff',
    }),
  );
  await writeRun(
    runId(40, 'fixture'),
    workflowManifest(runId(40, 'fixture'), 40, {
      status: 'failed',
      taskOutcome: 'failed',
      executionState: 'interrupted',
      terminationReason: 'owner_lost',
    }),
  );
  await writeRun(
    runId(50, 'research'),
    workflowManifest(runId(50, 'research'), 50, {
      workflowName: 'research',
      runKind: 'agentic',
      taskOutcome: 'partial',
    }),
    { 'brief.json': '{}' },
  );
  // Ties on startedAt between two workflow runs.
  await writeRun('tie-b', workflowManifest('tie-b', 60, { durationMs: null }));
  await writeRun('tie-a', workflowManifest('tie-a', 60));
  // A directory that does not use the run-id grammar, and broken ones.
  await writeRun('legacy-run', workflowManifest('legacy-run', 5, { workflowName: 'legacy' }));
  await writeRun(runId(70, 'broken'), '{ not json');
  await writeRun(runId(80, 'pipeline'), {
    type: 'ask',
    query: 'pipeline only',
    started_at: at(80),
    status: 'ok',
  });

  if (mode === 'rebuilt-index') {
    // index.db is a directory: the opener moves it aside and rebuilds from the run tree.
    await mkdir(join(dataDir(), 'index.db'), { recursive: true });
    return;
  }
  if (mode === 'no-index') {
    indexOff = true;
    return;
  }
  const history = await openHistory();
  if (history === null) throw new Error('index unavailable');
  try {
    await history.store.record(entry(runId(90, 'ask'), 90, { taskOutcome: 'fulfilled' }));
    await history.store.record(
      entry(runId(85, 'research'), 85, {
        taskType: 'research',
        intentText: 'deep question',
        costUsd: 0.12,
        taskOutcome: 'partial',
        briefId: 'b1',
      }),
    );
    await history.store.record(entry(runId(15, 'ask'), 15, { status: 'failed' }));
    // The index row wins over the file row for a shared run.
    await history.store.record(
      entry(runId(10, 'fixture'), 10, {
        taskType: 'run',
        intentText: 'fixture',
        status: 'succeeded',
        taskOutcome: 'fulfilled',
      }),
    );
  } finally {
    history.close();
  }
}

async function cli(argv: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  const context = createTerminalContext({
    env: { YANTRA_HOME: home, LLM_PROVIDER: 'none', NO_COLOR: '1' },
    cwd: dataDir(),
    isTty: false,
    stdout: sink((text) => (stdout += text)),
    stderr: sink((text) => (stderr += text)),
  });
  await executeCommand([...argv], context);
  return { stdout, stderr };
}

function stripAdditive(document: unknown): unknown {
  const value = document as { items?: Record<string, unknown>[] };
  return {
    ...value,
    items: (value.items ?? []).map((item) => {
      const copy = { ...item };
      for (const key of ADDITIVE_KEYS) delete copy[key];
      return copy;
    }),
  };
}

function golden(name: string, actual: string): string {
  const path = join(GOLDENS, name);
  if (CAPTURE) {
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(path, actual);
    return actual;
  }
  if (!existsSync(path)) throw new Error(`Missing golden ${name}`);
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-list-ledger-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});

afterEach(async () => {
  indexOff = false;
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

const CASES = [
  ['list', ['list']],
  ['list-runs-limit-3', ['list', 'runs', '--limit', '3']],
  ['list-runs-workflow', ['list', 'runs', '--workflow', 'fixture']],
  ['list-runs-workflow-research', ['list', 'runs', '--workflow', 'research']],
  ['list-runs-status-completed', ['list', 'runs', '--status', 'completed']],
  ['list-runs-status-succeeded', ['list', 'runs', '--status', 'succeeded']],
  ['list-runs-status-failed-limit-1', ['list', 'runs', '--status', 'failed', '--limit', '1']],
  ['list-workflows', ['list', 'workflows']],
] as const;

describe.each(['index', 'rebuilt-index', 'no-index'] as const)('yantra list with %s', (label) => {
  beforeEach(async () => {
    await seed(label);
  });

  it.each(CASES)('%s: terminal output and stderr are unchanged', async (name, argv) => {
    const { stdout, stderr } = await cli(argv);
    expect(stdout).toBe(golden(`${label}.${name}.txt`, stdout));
    expect(stderr).toBe(golden(`${label}.${name}.stderr.txt`, stderr));
  });

  it.each(CASES)('%s: --json equals the golden plus only the additive keys', async (name, argv) => {
    const { stdout } = await cli([...argv, '--json']);
    const actual = JSON.parse(stdout) as unknown;
    const expected = JSON.parse(
      golden(`${label}.${name}.json`, `${JSON.stringify(stripAdditive(actual), null, 2)}\n`),
    ) as unknown;

    // Same keys in the same order, once the additive keys are removed.
    expect(JSON.stringify(stripAdditive(actual))).toBe(JSON.stringify(expected));
  });
});

describe('additive JSON fields', () => {
  it('reports the mode, cost and document flag on each run', async () => {
    await seed('index');
    const { stdout } = await cli(['list', '--json']);
    const items = (JSON.parse(stdout) as { items: Record<string, unknown>[] }).items;
    const byId = new Map(items.map((item) => [item.runId, item]));

    expect(byId.get(runId(85, 'research'))).toMatchObject({
      taskType: 'research',
      costUsd: 0.12,
      hasDocument: true,
    });
    expect(byId.get(runId(50, 'research'))).toMatchObject({
      taskType: 'research',
      costUsd: null,
      hasDocument: true,
    });
    expect(byId.get(runId(20, 'fixture'))).toMatchObject({ taskType: 'run', hasDocument: false });
    for (const item of items) {
      const keys = Object.keys(item);
      // The additive keys always come after every pre-existing key.
      expect(keys.slice(-3)).toEqual([...ADDITIVE_KEYS]);
    }
  });
});
