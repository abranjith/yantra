// @no-llm
/**
 * Every run is owned (FEAT-064 TASK-008): workflow replay and deterministic
 * research hold `lease.json` and serve the run socket while they run, record
 * their browsers, answer `cancel`, and release only after the terminal event
 * and terminal manifest are on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, type RunLease, type WorkflowFile } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  BrowserLaunchContext,
  BrowserProvider,
  BrowserSession,
  Page,
} from '../../src/browser/types.js';
import type { FetchedDoc, SearchResult } from '../../src/extraction/types.js';
import { FollowUpQueryGenerator } from '../../src/research/query-gen.js';
import { ResearchLoop } from '../../src/research/research-loop.js';
import { RunChannelClient, type CancelAck } from '../../src/run-channel/client.js';
import { RUN_EVENTS_FILENAME } from '../../src/run-events/log.js';
import { scanRunEventsTail } from '../../src/run-events/reader.js';
import { OWNED_BROWSERS_FILENAME, RUN_LEASE_FILENAME } from '../../src/run-ownership/constants.js';
import { readLease } from '../../src/run-ownership/lease-store.js';
import { RunOwnershipSession } from '../../src/run-ownership/ownership-session.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import { RunOrchestrator } from '../../src/workflow/replay/run-orchestrator.js';
import { LocalRunStore } from '../../src/workflow/replay/run-store.js';
import type { WorkflowStore } from '../../src/workflow/store.types.js';
import { cleanupSandbox, sandboxHome } from '../run-channel/support.js';

const dirs: string[] = [];
beforeEach(() => {
  sandboxHome();
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  cleanupSandbox();
});

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yantra-own-paths-'));
  dirs.push(root);
  return root;
}

function workflow(steps: number): WorkflowFile {
  return {
    version: 1,
    name: 'fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'auto',
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i + 1}`,
      verb: 'navigate' as const,
      scope: null,
      requires_confirmation: false,
      confirmation_description: null,
      expected_cost: null,
      consequence: null,
      url: `https://example.com/${i + 1}`,
    })),
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
  } as WorkflowFile;
}

/** What the run directory looked like at one moment. */
interface Snapshot {
  readonly lease: boolean;
  readonly manifestStatus: string | null;
  readonly lastEventKind: string | null;
}

function snapshot(runDir: string): Snapshot {
  const manifestPath = join(runDir, 'manifest.json');
  return {
    lease: existsSync(join(runDir, RUN_LEASE_FILENAME)),
    manifestStatus: existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { status: string }).status
      : null,
    lastEventKind: scanRunEventsTail(join(runDir, RUN_EVENTS_FILENAME)).lastKind,
  };
}

/** A run store that snapshots the run directory just before releasing it. */
class ObservedRunStore extends LocalRunStore {
  public readonly atRelease: Snapshot[] = [];

  public constructor(private readonly root: string) {
    super(root);
  }

  public override async releaseOwnership(runId: string): Promise<void> {
    this.atRelease.push(snapshot(join(this.root, runId)));
    await super.releaseOwnership(runId);
  }
}

interface ReplayHooks {
  /** Runs inside the first navigation, while the run is live. */
  readonly duringStep?: (runDir: string) => Promise<void>;
  readonly failOn?: string;
}

function replaySetup(root: string, hooks: ReplayHooks = {}) {
  const runStore = new ObservedRunStore(root);
  const launches: BrowserLaunchContext[] = [];
  let currentRunDir = '';
  const provider: BrowserProvider = {
    detectChrome: () => Promise.resolve(null),
    launch: async (_options, context = {}) => {
      launches.push(context);
      const browser = { pid: 7001, startToken: 'test:7001' };
      await context.ownershipRecorder?.recordSpawned(browser);
      const page = {
        goto: async (url: string) => {
          if (url === hooks.failOn) throw new Error('connection reset');
          if (url.endsWith('/1')) await hooks.duringStep?.(currentRunDir);
          return null;
        },
        close: () => Promise.resolve(),
        url: () => 'about:blank',
      } as unknown as Page;
      return {
        id: 'session',
        chrome: { majorVersion: 150 },
        profilePath: join(root, 'profile'),
        newPage: () => Promise.resolve(page),
        newIsolatedPage: () => Promise.resolve(page),
        close: async () => {
          await context.ownershipRecorder?.recordExited(browser);
        },
        on: () => undefined,
      } as unknown as BrowserSession;
    },
  };
  const original = runStore.createRun.bind(runStore);
  runStore.createRun = async (request) => {
    const created = await original(request);
    currentRunDir = created.runDir;
    return created;
  };
  const orchestrator = new RunOrchestrator({
    workflowStore: {
      load: () => Promise.resolve(ok(workflow(2))),
    } as unknown as WorkflowStore,
    runStore,
    browserProvider: provider,
    keychain: {} as never,
    ethicsGate: { check: () => Promise.resolve() },
    logger: silent,
  });
  return { orchestrator, runStore, launches };
}

const request = { workflowName: 'fixture', params: {}, budgets: {}, json: false, debug: false };

function leaseOf(runDir: string): RunLease {
  return JSON.parse(readFileSync(join(runDir, RUN_LEASE_FILENAME), 'utf8')) as RunLease;
}

/** Every file under `dir`, as text, for leak checks. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? allText(path) : readFileSync(path, 'utf8')))
    .join('\n');
}

async function cancelOnce(runDir: string, times = 1): Promise<(CancelAck | null)[]> {
  const read = await readLease(runDir);
  if (read.kind !== 'lease') throw new Error('no lease');
  const client = new RunChannelClient({ clientKind: 'test', runDir, logger: silent });
  try {
    const connected = await client.connect(read.lease);
    expect(connected.state).toBe('attached');
    const acks: (CancelAck | null)[] = [];
    for (let index = 0; index < times; index += 1) acks.push(await client.cancel());
    return acks;
  } finally {
    client.close();
  }
}

describe('@no-llm workflow replay is owned', () => {
  it('holds the lease while running and releases it after the terminal event and manifest', async () => {
    const root = await tempRoot();
    let during: Snapshot | null = null;
    let lease: RunLease | null = null;
    const { orchestrator, runStore } = replaySetup(root, {
      duringStep: (runDir) => {
        during = snapshot(runDir);
        lease = leaseOf(runDir);
        return Promise.resolve();
      },
    });
    const outcome = await orchestrator.run(request);
    const runDir = join(root, outcome.runId);
    expect(during).toMatchObject({ lease: true, manifestStatus: 'running' });
    expect(lease).toMatchObject({ run_id: outcome.runId, origin: 'terminal', command: ['run'] });
    expect(runStore.atRelease).toEqual([
      { lease: true, manifestStatus: 'completed', lastEventKind: 'run_outcome' },
    ]);
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(false);
    expect(existsSync(join(runDir, '.lock'))).toBe(false);
  });

  it('releases a run that fails mid-run only after its failure manifest and event', async () => {
    const root = await tempRoot();
    const { orchestrator, runStore } = replaySetup(root, { failOn: 'https://example.com/2' });
    const outcome = await orchestrator.run(request);
    expect(outcome.kind).toBe('failure');
    expect(runStore.atRelease).toEqual([
      { lease: true, manifestStatus: 'failed', lastEventKind: 'run_outcome' },
    ]);
  });

  it("records the run's browser while it runs and proves it exited before release", async () => {
    const root = await tempRoot();
    let owned = '';
    const { orchestrator, launches } = replaySetup(root, {
      duringStep: (runDir) => {
        owned = readFileSync(join(runDir, OWNED_BROWSERS_FILENAME), 'utf8');
        return Promise.resolve();
      },
    });
    const outcome = await orchestrator.run(request);
    expect(launches[0]?.ownershipRecorder).toBeDefined();
    expect(owned).toContain('"op":"spawned"');
    expect(owned).toContain('"pid":7001');
    const runDir = join(root, outcome.runId);
    expect(existsSync(join(runDir, OWNED_BROWSERS_FILENAME))).toBe(false);
    expect(existsSync(join(runDir, RUN_LEASE_FILENAME))).toBe(false);
  });

  it('acknowledges cancel as not honored, completes normally, and marks a repeat already_cancelling', async () => {
    const root = await tempRoot();
    let acks: (CancelAck | null)[] = [];
    const { orchestrator } = replaySetup(root, {
      duringStep: async (runDir) => {
        acks = await cancelOnce(runDir, 2);
      },
    });
    const outcome = await orchestrator.run(request);
    expect(outcome.kind).toBe('success');
    expect(acks).toEqual([
      { alreadyCancelling: false, honored: false },
      { alreadyCancelling: true, honored: false },
    ]);
  });

  it('never writes the run token into any run artifact', async () => {
    const root = await tempRoot();
    let token = '';
    const { orchestrator } = replaySetup(root, {
      duringStep: (runDir) => {
        token = leaseOf(runDir).run_token;
        return Promise.resolve();
      },
    });
    const outcome = await orchestrator.run(request);
    expect(token).toHaveLength(43);
    expect(allText(join(root, outcome.runId))).not.toContain(token);
  });
});

const FIXED = '2026-06-15T00:00:00.000Z';

function researchLoop(root: string, onSearch: (runDir: string) => Promise<void>) {
  const finishes: Snapshot[] = [];
  let runDir = '';
  const research = new ResearchLoop({
    searchProvider: {
      name: 'duckduckgo',
      search: async (q: string): Promise<SearchResult[]> => {
        await onSearch(runDir);
        return [1, 2].map((n) => ({
          url: `https://example.com/${q.length}-${n}`,
          title: `${q} ${n}`,
          snippet: q,
          source: 'duckduckgo',
          rank: n - 1,
          publishedAt: null,
        }));
      },
    },
    fetcher: {
      fetch: (url: string): Promise<FetchedDoc> =>
        Promise.resolve({
          url,
          finalUrl: url,
          fetchedAt: FIXED,
          contentType: 'text/html',
          html: '<p>Electric vehicles saw battery prices fall while charging expanded.</p>',
          statusCode: 200,
          fetchMode: 'http',
          elapsedMs: 5,
        }),
    },
    extractor: {
      extract: (doc: FetchedDoc) =>
        Promise.resolve({
          url: doc.finalUrl,
          title: doc.finalUrl,
          byline: null,
          publishedAt: null,
          siteName: 'example.com',
          contentText:
            'Electric vehicles saw battery prices fall while charging networks expanded across regions.',
          contentHtml: '',
          excerpt: '',
          lengthChars: 100,
        }),
    },
    ethicsGate: { checkUrl: () => Promise.resolve({ ok: true as const }) },
    synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
    queryGen: new FollowUpQueryGenerator(),
    logger: silent,
    runRootDir: root,
    clock: () => new Date(FIXED),
    budgetNow: () => 0,
    openOwnership: async (options) => {
      runDir = options.runDir;
      const session = await RunOwnershipSession.open(options);
      const finish = session.finish.bind(session);
      session.finish = () => {
        finishes.push(snapshot(options.runDir));
        return finish();
      };
      return session;
    },
  });
  return { research, finishes };
}

describe('@no-llm deterministic research is owned', () => {
  it('serves a socket while running, answers cancel as not honored, and releases after its outcome', async () => {
    const root = await tempRoot();
    let during: { lease: RunLease | null; acks: (CancelAck | null)[] } | null = null;
    const { research, finishes } = researchLoop(root, async (runDir) => {
      if (during !== null) return;
      const read = await readLease(runDir);
      during = {
        lease: read.kind === 'lease' ? read.lease : null,
        acks: await cancelOnce(runDir),
      };
    });
    const result = await research.run({
      topic: 'electric vehicles',
      budget: { maxHops: 2, maxSources: 24, maxWallClockMs: 60_000, maxLlmCalls: 4 },
      noLlm: true,
      length: 'medium',
      scope: 'public',
      perQueryLimit: 2,
      perFetchTimeoutMs: 5_000,
      coverageTarget: 1.1,
    });
    expect(result.hops.length).toBeGreaterThanOrEqual(1);
    expect(during).toMatchObject({
      lease: { command: ['research'], origin: 'terminal' },
      acks: [{ alreadyCancelling: false, honored: false }],
    });
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ lease: true, lastEventKind: 'run_outcome' });
    const [runId] = readdirSync(root);
    expect(existsSync(join(root, runId ?? '', RUN_LEASE_FILENAME))).toBe(false);
  });
});
