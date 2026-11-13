// @no-llm
/**
 * In-process reads (FEAT-065 TASK-007): parity with `yantra <cmd> --json`,
 * cursor paging, the unmapped-read allowlist and per-item failure.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type * as CoreModule from '@yantra/core';
import { dataDir, resetPathCache, runsRoot, workflowsRoot, type HistoryEntry } from '@yantra/core';
import {
  ReadListParams,
  ReadParams,
  type ListResult,
  type ReadResult,
  type RunLedgerPage,
} from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../../src/execute.js';
import { openHistory } from '../../../src/history.js';
import { READERS, UNMAPPED_READS, readPaths, registerReads } from '../../../src/ui/host/reads.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';

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

const WORKFLOW =
  'version: 1\nname: fixture\ndescription: Read fixture\nsecurity_class: public\nparams: {}\nsecrets: []\ncookies: none\nsteps:\n  - id: s1\n    verb: navigate\n    url: https://fixture.example\n    scope: null\noutputs: []\n';

let home: string;
let methods: RpcMethodRegistry;
const CALL = { windowId: 'w', connection: {} } as unknown as RpcCallContext;

function manifest(runId: string, startedAt: string): string {
  return JSON.stringify({
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
  });
}

async function writeRun(runId: string, startedAt: string): Promise<void> {
  const dir = join(runsRoot(), runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), manifest(runId, startedAt));
}

function at(index: number): string {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString();
}

/** `read.list` with a target of runs: one Ledger page. */
async function ledger(params: unknown = {}): Promise<RunLedgerPage> {
  const registered = methods.get('read.list');
  if (registered === undefined) throw new Error('no read.list');
  return (await registered.handler(ReadListParams.parse(params), CALL)) as RunLedgerPage;
}

async function read(method: string, params: unknown = {}): Promise<ReadResult> {
  const registered = methods.get(method);
  if (registered === undefined) throw new Error(`no ${method}`);
  return (await registered.handler(ReadParams.parse(params), CALL)) as ReadResult;
}

/** `yantra <argv> --json` in-process, exactly as the terminal runs it. */
async function cliJson(argv: readonly string[]): Promise<unknown> {
  let stdout = '';
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  const context = createTerminalContext({
    env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
    cwd: dataDir(),
    isTty: false,
    stdout: sink,
    stderr: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  await executeCommand([...argv, '--json'], context);
  return JSON.parse(stdout) as unknown;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-reads-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
  methods = new RpcMethodRegistry();
  registerReads(methods, { env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' }, cwd: dataDir() });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

describe('parity with yantra <cmd> --json', () => {
  beforeEach(async () => {
    await mkdir(workflowsRoot(), { recursive: true });
    await writeFile(join(workflowsRoot(), 'fixture.yaml'), WORKFLOW);
    await writeRun('run-fixed', '2026-11-07T00:00:00.000Z');
    await writeFile(join(runsRoot(), 'run-fixed', 'report.md'), '# Fixture report\n');
  });

  it('read.list runs pages the same items as yantra list runs --json', async () => {
    const page = await ledger({ limit: 20 });
    const cli = (await cliJson(['list', 'runs', '--limit', '20'])) as ListResult;
    expect(page.items).toEqual(cli.items);
    expect({ schemaVersion: page.schemaVersion, kind: page.kind }).toEqual({
      schemaVersion: cli.schemaVersion,
      kind: cli.kind,
    });
  });

  it('read.list workflows equals the CLI document', async () => {
    const registered = methods.get('read.list')!;
    const value = await registered.handler(ReadListParams.parse({ target: 'workflows' }), CALL);
    expect(value).toEqual(await cliJson(['list', 'workflows']));
  });

  it.each([
    [
      'read.show',
      { args: ['fixture'], options: { workflow: true } },
      ['show', 'fixture', '--workflow'],
    ],
    ['read.show', { args: ['run-fixed'], options: { run: true } }, ['show', 'run-fixed', '--run']],
    ['read.audit', { args: ['run-fixed'] }, ['audit', 'run-fixed']],
    ['read.report', { args: ['run-fixed'] }, ['report', 'run-fixed']],
    ['read.prefs.list', {}, ['prefs', 'list']],
    ['read.prefs.get', { args: ['defaults.detail'] }, ['prefs', 'get', 'defaults.detail']],
    ['read.daemon.status', {}, ['daemon', 'status']],
  ] as const)('%s %j equals the CLI document', async (method, params, argv) => {
    // Act
    const result = await read(method, params);
    const cli = await cliJson(argv);

    // Assert
    expect(result.value).toEqual(cli);
    expect(result.schema).toBeNull();
  });
});

describe('read.list paging', () => {
  it('visits each of 120 indexed runs exactly once, even with a run inserted between pages', async () => {
    // Arrange: 120 runs in the history index.
    const history = await openHistory();
    if (history === null) throw new Error('index unavailable');
    const entry = (i: number): HistoryEntry => ({
      runId: `run-${String(i).padStart(4, '0')}`,
      taskType: 'ask',
      intentText: `q${i}`,
      briefId: null,
      status: 'succeeded',
      startedAt: at(i),
      finishedAt: at(i),
      durationMs: 1,
      costUsd: null,
      provider: null,
      taskOutcome: null,
    });
    for (let i = 0; i < 120; i++) await history.store.record(entry(i));

    // Act
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await ledger({ limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.runId));
      pages += 1;
      if (pages === 1) await history.store.record(entry(999)); // newest; must not appear later
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    history.close();

    // Assert
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).not.toContain('run-0999');
  }, 60_000);

  it('pages the file-scan fallback identically when the index is unavailable', async () => {
    // Arrange: the index cannot open (a broken index.db is rebuilt instead, so stub it).
    methods = new RpcMethodRegistry();
    registerReads(methods, {
      env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
      cwd: dataDir(),
      openHistory: () => Promise.resolve(null),
    });
    for (let i = 0; i < 120; i++) await writeRun(`file-${String(i).padStart(4, '0')}`, at(i));

    // Act
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await ledger({ limit: 50, ...(cursor ? { cursor } : {}) });
      expect(page.source).toBe('files');
      seen.push(...page.items.map((item) => item.runId));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }

    // Assert
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('file-0119');
    expect(seen.at(-1)).toBe('file-0000');
  }, 60_000);

  it('returns the other rows when one manifest is corrupt', async () => {
    await writeRun('good-a', at(1));
    await writeRun('good-b', at(2));
    await mkdir(join(runsRoot(), 'broken'), { recursive: true });
    await writeFile(join(runsRoot(), 'broken', 'manifest.json'), '{ not json');
    const page = await ledger();
    const ids = page.items.map((item) => item.runId);
    expect(ids).toEqual(['good-b', 'good-a']);
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['valid base64 of the wrong shape', Buffer.from('{"v":2}').toString('base64url')],
    [
      'a tampered timestamp',
      Buffer.from('{"v":1,"s":"yesterday","r":"run-1"}').toString('base64url'),
    ],
  ])('refuses %s with invalid_params', async (_label, cursor) => {
    const error = await ledger({ cursor }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32602);
    expect((error as RpcError).data.remediation).toBe('Start again without a cursor.');
  });

  it.each([
    ['limit 1000', { limit: 1000 }],
    ['limit 0', { limit: 0 }],
    ['the FEAT-065 args form', { args: ['runs'] }],
    ['an option bag', { options: { limit: '5' } }],
    ['an unknown target', { target: 'schedules' }],
    ['a text filter over 200 characters', { text: 'x'.repeat(201) }],
  ])('refuses %s as invalid params', (_label, params) => {
    expect(methods.get('read.list')!.params.safeParse(params).success).toBe(false);
  });

  it('defaults the page size to 50', () => {
    expect(methods.get('read.list')!.params.parse({})).toEqual({ target: 'runs', limit: 50 });
  });
});

describe('errors', () => {
  it('turns a reader failure into not_found with the CLI message', async () => {
    const error = await read('read.audit', { args: ['no-such-run'] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32004);
  });

  it('refuses an option the command does not take', async () => {
    const error = await read('read.show', { args: ['x'], options: { nope: true } }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RpcError).code).toBe(-32602);
  });

  it('refuses an option that turns the read into a mutation', async () => {
    const error = await read('read.prefs.list', { options: { forget: 'defaults.detail' } }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RpcError).code).toBe(-32003);
  });

  it('refuses --json passed as an option', async () => {
    const error = await read('read.show', { args: ['x'], options: { json: true } }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RpcError).code).toBe(-32602);
  });

  it('refuses cursor paging on an unpaged read', async () => {
    const error = await read('read.show', { args: ['x'], limit: 5 }).catch(
      (caught: unknown) => caught,
    );
    expect((error as RpcError).code).toBe(-32602);
  });
});

describe('coverage', () => {
  it('maps or allowlists every read-class registry path', () => {
    const mapped = new Set(READERS.map((reader) => reader.path.join(' ')));
    const allowed = new Set(UNMAPPED_READS.map((entry) => entry.path));
    const uncovered = readPaths().filter((path) => !mapped.has(path) && !allowed.has(path));
    expect(uncovered).toEqual([]);
  });

  it('keeps no stale allowlist entry that is no longer a read path', () => {
    const paths = new Set(readPaths());
    expect(UNMAPPED_READS.filter((entry) => !paths.has(entry.path))).toEqual([]);
  });

  it('never both maps and allowlists a path', () => {
    const mapped = new Set(READERS.map((reader) => reader.path.join(' ')));
    expect(UNMAPPED_READS.filter((entry) => mapped.has(entry.path))).toEqual([]);
  });

  it('dates every allowlist entry and gives it to FEAT-070', () => {
    for (const entry of UNMAPPED_READS)
      expect(entry).toMatchObject({ since: '2026-11-03', owner: 'FEAT-070' });
  });

  it('fails the coverage check for an unmapped, unallowlisted read path', () => {
    const paths = [...readPaths(), 'imaginary read'];
    const mapped = new Set(READERS.map((reader) => reader.path.join(' ')));
    const allowed = new Set(UNMAPPED_READS.map((entry) => entry.path));
    expect(paths.filter((path) => !mapped.has(path) && !allowed.has(path))).toEqual([
      'imaginary read',
    ]);
  });
});
