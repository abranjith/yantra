/// <reference lib="dom" />
/**
 * @no-llm Run results end to end (FEAT-066 TASK-010, M1): the built CLI's
 * real host and real Chrome over a sandboxed YANTRA_HOME seeded with every
 * kind of run — every golden Brief, runs without a document, legacy and
 * corrupt artifacts, a large run, and a run directory holding files that must
 * never be served.
 *
 * Flows: Ledger → filter → result; every citation chip; Audit;
 * `tool-calls.jsonl` to its end; refused artifact paths. Plus the
 * responsiveness budget, CLI parity of every outcome word, a canary that
 * never leaves the run, axe on every route in light and dark, and a
 * keyboard-only path.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resetPathCache, runsRoot } from '@yantra/core';
import {
  UiOpenResult,
  type AuditPage,
  type JsonlWindow,
  type RunResultView,
} from '@yantra/protocol';
import {
  askBriefRun,
  buildRunDir,
  fixtureBrief,
  fixtureInstant,
  fixtureRunId,
  fixtureSource,
  interruptedLegacyRun,
  jsonl,
  legacyReportRun,
  startupFailureRun,
  templatedRun,
  workflowManifest,
  workflowOutputsRun,
  writeLargeRun,
  type RunDirSpec,
} from '@yantra/test-helpers/run-dirs';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { launchGalleryBrowser } from './drshya/browser.js';
import { runAxe } from './drshya/capture.js';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');
const GOLDEN_BRIEFS = resolve(import.meta.dirname, 'golden-briefs', 'expected');
const TIMEOUT = 120_000;
const CANARY = 'CANARY-7f3a9c1e-never-leaves-the-run';

let home: string;
let browser: Browser;
let opened: UiOpenResult;
let origin: string;
let rpc: NodeRpc;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** A scenario under another run id: the directory and its manifest agree, as in a real run. */
function renamed(
  spec: RunDirSpec,
  runId: string,
  files: RunDirSpec['files'] = spec.files,
): RunDirSpec {
  const manifest =
    spec.manifest !== undefined && spec.manifest !== null && typeof spec.manifest === 'object'
      ? { ...spec.manifest, runId }
      : spec.manifest;
  return {
    runId,
    ...(manifest === undefined ? {} : { manifest }),
    ...(files === undefined ? {} : { files }),
  };
}

const RUN = {
  brief: askBriefRun(1_000),
  templated: templatedRun(1_010),
  workflow: workflowOutputsRun(1_020),
  startupFailure: startupFailureRun(1_030),
  interrupted: interruptedLegacyRun(1_040),
  legacy: legacyReportRun(1_050),
  corrupt: ((): RunDirSpec => {
    const spec = askBriefRun(1_060);
    const { 'run-health.json': _health, ...files } = spec.files ?? {};
    return renamed(spec, fixtureRunId(1_060, 'corrupt'), { ...files, 'brief.json': '{"title": ' });
  })(),
  older: ((): RunDirSpec => {
    const spec = askBriefRun(1_070);
    return renamed(spec, fixtureRunId(1_070, 'older'), {
      ...spec.files,
      'brief.json': fixtureBrief({ schema_version: '0.1' }),
    });
  })(),
  actions: ((): RunDirSpec => {
    const spec = askBriefRun(1_080);
    return renamed(spec, fixtureRunId(1_080, 'do'), {
      ...spec.files,
      'brief.json': fixtureBrief({
        title: 'Checkout with evidence',
        overview: 'Signed in [A1] after reading the policy [1]. Legacy token [A9].',
        actions: [
          {
            id: 'A1',
            kind: 'fill',
            label: 'Password',
            label_origin: 'explicit',
            ref: 'e12',
            epoch: 3,
            call_id: 'call-7',
            host: 'shop.example',
            verification: { withheld: { reason: 'password', verdict: 'unchecked' } },
          },
        ],
        key_findings: [
          {
            text: 'Signed in [A1]',
            citations: [],
            actions: ['A1'],
            editorial: false,
            facet: null,
            children: [],
          },
          {
            text: 'Policy allows returns [1]',
            citations: [1],
            editorial: false,
            facet: null,
            children: [],
          },
        ],
        sources: [fixtureSource(1, { excerpt: 'Returns are accepted within 30 days.' })],
      }),
      'secrets.jsonl': jsonl([
        { key: 'shop_password', step_id: 'fill-1', ts: fixtureInstant(1_081), value: CANARY },
      ]),
    });
  })(),
  denied: ((): RunDirSpec => {
    const runId = fixtureRunId(1_090, 'denied');
    return {
      runId,
      manifest: workflowManifest(runId, { startedAt: fixtureInstant(1_090) }),
      files: {
        'report.md': '# Report\n',
        'lease.json': `{"run_token":"${CANARY}"}`,
        'decisions/x.json': `{"secret":"${CANARY}"}`,
        'brief.json.tmp': `{"partial":"${CANARY}"}`,
      },
    };
  })(),
};

/** One run per outcome word, for the CLI parity check. */
const PARITY: readonly { readonly spec: RunDirSpec; readonly interrupted: boolean }[] = [
  ['fulfilled', 'completed', false],
  ['partial', 'completed', false],
  ['handoff', 'paused', false],
  ['failed', 'failed', false],
  ['aborted', 'aborted', false],
  [null, 'completed', false],
  ['failed', 'failed', true],
].map(([outcome, status, interrupted], index) => {
  const runId = fixtureRunId(2_000 + index, `parity-${String(outcome ?? 'none')}`);
  return {
    interrupted: interrupted as boolean,
    spec: {
      runId,
      manifest: workflowManifest(runId, {
        startedAt: fixtureInstant(2_000 + index),
        status,
        ...(outcome === null ? {} : { taskOutcome: outcome }),
        ...(interrupted === true
          ? { executionState: 'interrupted', terminationReason: 'owner_lost' }
          : {}),
      }),
      files: { 'report.md': '# Report\n' },
    },
  };
});

const LARGE_RUN = fixtureRunId(3_000, 'large');
const HUGE_CAPTURE_BYTES = 300 * 1024 * 1024;

function goldenBriefRuns(): RunDirSpec[] {
  return readdirSync(GOLDEN_BRIEFS)
    .filter((name) => name.endsWith('.brief.json'))
    .map((name, index) => {
      const brief = JSON.parse(readFileSync(join(GOLDEN_BRIEFS, name), 'utf8')) as Record<
        string,
        unknown
      >;
      const spec = askBriefRun(500 + index * 10);
      return renamed(spec, fixtureRunId(500 + index * 10, `golden-${String(index)}`), {
        ...spec.files,
        'brief.json': { ...brief, brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ' },
      });
    });
}

async function seed(): Promise<void> {
  const root = runsRoot();
  for (const spec of [
    ...Object.values(RUN),
    ...PARITY.map((item) => item.spec),
    ...goldenBriefRuns(),
  ]) {
    await buildRunDir(root, spec);
  }
  // A large run: 50,000 tool-call lines, 50,000 events and a 300 MB capture
  // that is never written (a sparse file: only its size is set).
  const large = await writeLargeRun(join(root, LARGE_RUN), 25_000);
  await writeFile(
    join(large, 'events.jsonl'),
    jsonl(
      Array.from({ length: 50_000 }, (_, n) => ({
        kind: 'step_started',
        step_id: `s${String(n)}`,
        scope: 'public',
      })),
    ),
  );
  await mkdir(join(large, 'captures'), { recursive: true });
  const handle = await open(join(large, 'captures', 'huge.png'), 'w');
  await handle.truncate(HUGE_CAPTURE_BYTES);
  await handle.close();
}

// ---------------------------------------------------------------------------
// A Node RPC client with its own window session
// ---------------------------------------------------------------------------

interface NodeRpc {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Raw responses, for the canary scan. */
  readonly received: string[];
  readonly cookie: string;
  close(): void;
}

function launchCode(): string {
  return new URL(openUrl().url).hash.slice('#code='.length);
}

async function connectRpc(): Promise<NodeRpc> {
  const response = await fetch(`${origin}/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: launchCode() }),
  });
  const grant = (await response.json()) as { window_capability: string };
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const socket = new WebSocket(`ws://127.0.0.1:${String(opened.port)}/rpc`, {
    headers: { cookie, origin },
  });
  await new Promise<void>((done, fail) => {
    socket.once('open', () => done());
    socket.once('error', fail);
  });
  const received: string[] = [];
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  socket.on('message', (data: Buffer) => {
    const text = data.toString('utf8');
    received.push(text);
    const message = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: { data?: { code?: string } };
    };
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error !== undefined)
      waiter?.reject(new Error(message.error.data?.code ?? 'rpc_error'));
    else waiter?.resolve(message.result);
  });
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'auth',
      params: { window_capability: grant.window_capability },
    }),
  );
  let next = 1;
  const client: NodeRpc = {
    received,
    cookie,
    call: <T>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((done, fail) => {
        const id = next++;
        pending.set(id, { resolve: (value) => done(value as T), reject: fail });
        socket.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
      }),
    close: () => socket.close(),
  };
  await client.call('host.hello', { build_id: 'e2e', channel_version: 1 });
  return client;
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function openUrl(): UiOpenResult {
  return UiOpenResult.parse(
    JSON.parse(
      execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
        env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', YANTRA_UI_ASSETS_DIR: '' },
        encoding: 'utf8',
      }),
    ),
  );
}

interface Watched {
  readonly page: Page;
  readonly requests: string[];
  readonly pageErrors: string[];
}

/** A connected app window, then navigated in-tab to `path` (a full page load). */
async function appAt(path: string): Promise<Watched> {
  const page = await browser.newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) =>
    pageErrors.push(error instanceof Error ? error.message : String(error)),
  );
  await page.goto(openUrl().url, { waitUntil: 'load' });
  await page.waitForSelector('[role="status"][data-status="connected"]', { timeout: 20_000 });
  await page.waitForFunction(() => sessionStorage.getItem('yantra.resume_code') !== null, {
    timeout: 10_000,
  });
  if (path !== '/') {
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    await page.waitForSelector('[role="status"][data-status="connected"]', { timeout: 20_000 });
  }
  return { page, requests, pageErrors };
}

async function axeBothThemes(page: Page): Promise<void> {
  // Without motion a theme switch is instant: axe must never read a color mid-transition.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const violations = await runAxe(page, 'body');
    // Name each failing node, so a failure says where it is, not just its generated id.
    const nodes = await page.evaluate(
      (targets) =>
        targets.map((target) => {
          const node = document.querySelector(target);
          if (node === null) return target;
          const style = getComputedStyle(node);
          return `${node.outerHTML.slice(0, 200)} color=${style.color} background=${style.backgroundColor}`;
        }),
      violations.flatMap((violation) => violation.targets),
    );
    expect({ path: page.url(), theme, violations, nodes }).toEqual({
      path: page.url(),
      theme,
      violations: [],
      nodes: [],
    });
  }
}

beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-results-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  await seed();
  opened = openUrl();
  origin = `http://127.0.0.1:${String(opened.port)}`;
  browser = await launchGalleryBrowser();
  rpc = await connectRpc();
}, TIMEOUT);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  rpc?.close();
  await browser?.close();
  try {
    process.kill(opened.hostPid);
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 50 && alive(opened.hostPid); i++)
    await new Promise((done) => setTimeout(done, 100));
  delete process.env.YANTRA_HOME;
  resetPathCache();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows can hold a file of a just-killed process a little longer; the
    // directory is a temp sandbox, so leaving it is harmless.
  }
});

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

describe('@no-llm run results in the Yantra app', () => {
  it(
    'Ledger → filter → open a result',
    async () => {
      const { page, pageErrors } = await appAt('/runs');
      await page.waitForSelector('[role="grid"]', { timeout: 20_000 });

      await page.type('input[type="search"]', RUN.actions.runId);
      await page.waitForFunction(
        (id) => new URLSearchParams(window.location.search).get('q') === id,
        { timeout: 10_000 },
        RUN.actions.runId,
      );
      await page.waitForFunction(
        (id) => {
          const rows = [...document.querySelectorAll('[role="grid"] [role="row"]')].slice(1);
          return rows.length === 1 && rows[0]?.textContent?.includes(id) === true;
        },
        { timeout: 10_000 },
        RUN.actions.runId,
      );
      await page.click('[role="rowheader"]');
      await page.waitForSelector('[data-document="brief"]', { timeout: 15_000 });

      expect(page.url()).toBe(`${origin}/runs/${RUN.actions.runId}`);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-document="brief"]', { timeout: 20_000 });
      expect(pageErrors).toEqual([]);
      await page.close();
    },
    TIMEOUT,
  );

  it('opens the evidence of every citation chip of every golden Brief in one click', async () => {
    for (const spec of goldenBriefRuns()) {
      const { page } = await appAt(`/runs/${spec.runId}`);
      await page.waitForSelector('[data-document="brief"]', { timeout: 20_000 });
      const labels = await page.$$eval('[data-document="brief"] button[data-citation]', (chips) =>
        chips.map((chip) => chip.getAttribute('aria-label') ?? ''),
      );
      const chips = await page.$$('[data-document="brief"] button[data-citation]');
      for (const [index, chip] of chips.entries()) {
        await chip.click();
        await page.waitForFunction(
          (label) =>
            document.querySelector('aside[aria-label="Evidence"] h2')?.textContent === label,
          { timeout: 5_000 },
          labels[index],
        );
      }
      await page.close();
    }
  }, 300_000);

  it(
    'shows action evidence, a protected value and a legacy action as not recorded',
    async () => {
      const { page } = await appAt(`/runs/${RUN.actions.runId}`);
      await page.waitForSelector('[data-document="brief"]', { timeout: 20_000 });

      await page.click('[data-document="brief"] button[aria-label="Action A1"]');
      await page.waitForSelector('aside [data-part="protected-value"][data-reason="password"]');
      await page.click('[data-document="brief"] button[aria-label="Action A9"]');
      await page.waitForSelector('aside [data-evidence="action-missing"]');
      await page.click('[data-document="brief"] button[aria-label="Source 1"]');
      await page.waitForFunction(
        () =>
          document.querySelector('aside blockquote')?.textContent ===
          'Returns are accepted within 30 days.',
      );

      expect(await page.content()).not.toContain(CANARY);
      await page.close();
    },
    TIMEOUT,
  );

  it('renders runs without a document, legacy runs and broken artifacts completely', async () => {
    for (const [spec, selector] of [
      [RUN.workflow, '[data-region="outputs"]'],
      [RUN.startupFailure, '[data-region="terminal"]'],
      [RUN.interrupted, '[data-part="interrupted"]'],
      [RUN.legacy, '[data-region="report"]'],
      [RUN.corrupt, '[data-slot-state="corrupt"]'],
      [RUN.older, '[data-slot-state="unsupported"]'],
      [RUN.templated, '[data-document="templated_report"]'],
    ] as const) {
      const { page, pageErrors } = await appAt(`/runs/${spec.runId}`);
      await page.waitForSelector(selector, { timeout: 20_000 });
      expect({ run: spec.runId, pageErrors }).toEqual({ run: spec.runId, pageErrors: [] });
      await page.close();
    }
  }, 300_000);

  it(
    'opens the Audit with the same story as yantra audit, keys only',
    async () => {
      const { page } = await appAt(`/runs/${RUN.actions.runId}/audit`);
      await page.waitForSelector('[data-part="trust-narrative"]', { timeout: 20_000 });

      const cli = JSON.parse(
        execFileSync(process.execPath, [BIN, 'audit', RUN.actions.runId, '--json'], {
          env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none' },
          encoding: 'utf8',
        }),
      ) as { trustNarrative: string };
      expect(await page.$eval('[data-part="trust-narrative"]', (node) => node.textContent)).toBe(
        cli.trustNarrative,
      );
      expect(
        await page.$eval('[data-secret-key="shop_password"]', (node) => node.textContent),
      ).toContain('shop_password');
      expect(await page.content()).not.toContain(CANARY);
      await page.close();
    },
    TIMEOUT,
  );

  it('opens tool-calls.jsonl of the large run and goes to its last line', async () => {
    const { page, requests } = await appAt(`/runs/${LARGE_RUN}/artifacts/tool-calls.jsonl`);
    await page.waitForSelector('[role="grid"]', { timeout: 30_000 });
    expect(await page.$$eval('[role="row"]', (rows) => rows.length)).toBeLessThanOrEqual(100);

    // Long tasks while scrolling.
    await page.evaluate(() => {
      (window as unknown as { __long: number[] }).__long = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          (window as unknown as { __long: number[] }).__long.push(entry.duration);
      }).observe({ type: 'longtask', buffered: false });
    });
    for (let i = 0; i < 20; i++) {
      await page.$eval('[role="grid"]', (grid) => {
        grid.scrollTop += 2_000;
      });
      await new Promise((done) => setTimeout(done, 50));
    }
    const longest = await page.evaluate(() =>
      Math.max(0, ...(window as unknown as { __long: number[] }).__long),
    );
    expect(longest).toBeLessThan(200);

    const [goToEnd] = await page.$$('xpath/.//button[contains(., "Go to the end")]');
    await goToEnd!.click();
    await page.waitForSelector('section[aria-label="Line 50000"]', { timeout: 30_000 });

    const lines = readFileSync(join(runsRoot(), LARGE_RUN, 'tool-calls.jsonl'), 'utf8')
      .trimEnd()
      .split('\n');
    const last = JSON.parse(lines.at(-1)!) as { call_id: string };
    expect(
      await page.$eval('section[aria-label="Line 50000"]', (node) => node.textContent),
    ).toContain(last.call_id);

    // The 300 MB capture is never requested.
    expect(requests.filter((url) => url.startsWith(`${origin}/a/`))).toEqual([]);
    await page.close();
  }, 180_000);

  it(
    'never loads the 300 MB capture: its viewer offers Show in folder',
    async () => {
      const { page, requests } = await appAt(`/runs/${LARGE_RUN}/artifacts/captures/huge.png`);
      await page.waitForSelector('[data-part="too-large"]', { timeout: 20_000 });
      expect(requests.filter((url) => url.startsWith(`${origin}/a/`))).toEqual([]);
      await page.close();
    },
    TIMEOUT,
  );

  it(
    'refuses every denied path and traversal, by RPC and by URL',
    async () => {
      for (const path of [
        'lease.json',
        'decisions/x.json',
        'brief.json.tmp',
        '../manifest.json',
        '../../outside.txt',
        'a\\b',
        'C:/Windows/win.ini',
        '%2e%2e/x',
        'brief.json',
      ]) {
        const error = await rpc.call('artifact.url', { run_id: RUN.denied.runId, path }).then(
          () => null,
          (caught: unknown) => (caught as Error).message,
        );
        // `brief.json` is typed: it reaches the app only through read.run_result.
        expect({ path, error }).toEqual({ path, error: 'not_allowed' });
      }
      // A forged token for lease.json is the same uniform 404.
      const forged = Buffer.from(
        JSON.stringify({ r: RUN.denied.runId, p: 'lease.json', w: 'x', e: Date.now() + 60_000 }),
      ).toString('base64url');
      const response = await fetch(`${origin}/a/${forged}.AAAA`, {
        headers: { cookie: rpc.cookie },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(CANARY);
      // A public file still serves, with nosniff and its registry type.
      const signed = await rpc.call<{ url: string }>('artifact.url', {
        run_id: RUN.denied.runId,
        path: 'report.md',
      });
      const ok = await fetch(`${origin}${signed.url}`, { headers: { cookie: rpc.cookie } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      // The inventory never names a denied file.
      const view = await rpc.call<RunResultView>('read.run_result', { run_id: RUN.denied.runId });
      expect(view.artifacts.map((item) => item.path)).toEqual(['manifest.json', 'report.md']);
    },
    TIMEOUT,
  );

  it(
    'keeps the canary out of every read',
    async () => {
      await rpc.call('read.audit', { run_id: RUN.actions.runId });
      await rpc.call('read.run_result', { run_id: RUN.actions.runId });
      await rpc.call('read.run_result', { run_id: RUN.denied.runId });
      expect(rpc.received.join('\n')).not.toContain(CANARY);
    },
    TIMEOUT,
  );
});

describe('@no-llm responsiveness budget', () => {
  it(
    'meets the read budgets on a large run',
    async () => {
      await rpc.call('read.run_result', { run_id: LARGE_RUN });
      const result = await timed(() =>
        rpc.call<RunResultView>('read.run_result', { run_id: LARGE_RUN }),
      );
      const first = await timed(() =>
        rpc.call<JsonlWindow>('read.artifact_window', {
          run_id: LARGE_RUN,
          path: 'events.jsonl',
          from_line: 0,
          limit: 200,
        }),
      );
      const later = await timed(() =>
        rpc.call<JsonlWindow>('read.artifact_window', {
          run_id: LARGE_RUN,
          path: 'events.jsonl',
          from_line: 200,
          limit: 200,
        }),
      );
      const ledger = await timed(() => rpc.call('read.list', { limit: 50 }));
      const audit = await timed(() => rpc.call<AuditPage>('read.audit', { run_id: LARGE_RUN }));

      expect({
        runResult: result.ms < 300,
        firstWindow: first.ms < 1_000,
        laterWindow: later.ms < 150,
        ledger: ledger.ms < 300,
      }).toEqual({ runResult: true, firstWindow: true, laterWindow: true, ledger: true });
      expect(audit.value.tool_calls.total).toBe(25_000);
      expect(Buffer.byteLength(JSON.stringify(audit.value))).toBeLessThanOrEqual(768 * 1024);
    },
    TIMEOUT,
  );
});

describe('@no-llm CLI parity', () => {
  it('words every outcome in the Ledger exactly as yantra list does', async () => {
    const listed = execFileSync(process.execPath, [BIN, 'list', '--limit', '500'], {
      env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', NO_COLOR: '1' },
      encoding: 'utf8',
    });
    const cliSegment = new Map(
      listed
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [runId = '', segment = ''] = line.split(/\s{2,}/u);
          return [runId, segment] as const;
        }),
    );

    for (const { spec, interrupted } of PARITY) {
      const { page } = await appAt(`/runs?q=${spec.runId}`);
      await page.waitForFunction(
        (id) =>
          [...document.querySelectorAll('[role="row"]')].some(
            (row) => row.textContent?.includes(id) === true,
          ),
        { timeout: 15_000 },
        spec.runId,
      );
      const badge = await page.$eval(
        '[role="row"] [data-part="outcome"] [data-part="text"]',
        (node) => node.textContent,
      );
      const chip = await page.$('[role="row"] [data-part="execution-state"]');
      const cli = cliSegment.get(spec.runId);
      if (interrupted) {
        expect(cli?.startsWith('interrupted · ')).toBe(true);
        expect(chip).not.toBeNull();
      } else {
        expect({ run: spec.runId, app: badge }).toEqual({ run: spec.runId, app: cli });
        expect(chip).toBeNull();
      }
      await page.close();
    }
  }, 300_000);
});

describe('@no-llm accessibility', () => {
  it('passes axe on every route, in light and dark', async () => {
    for (const [path, ready] of [
      ['/runs', '[role="grid"]'],
      [`/runs/${RUN.brief.runId}`, '[data-document="brief"]'],
      [`/runs/${RUN.workflow.runId}`, '[data-document="none"]'],
      [`/runs/${RUN.actions.runId}/audit`, '[data-part="trust-narrative"]'],
      [`/runs/${LARGE_RUN}/artifacts/tool-calls.jsonl`, '[role="grid"]'],
      [`/runs/${RUN.workflow.runId}/artifacts/outputs.json`, '[data-part="event-inspector"]'],
      [`/runs/${RUN.brief.runId}/artifacts/brief.md`, '.safe-markdown'],
      [`/runs/${LARGE_RUN}/artifacts/captures/huge.png`, '[data-part="too-large"]'],
    ] as const) {
      const { page } = await appAt(path);
      await page.waitForSelector(ready, { timeout: 30_000 });
      await axeBothThemes(page);
      await page.close();
    }
  }, 300_000);

  it(
    'works by keyboard: Ledger → result → chip → evidence → back to the chip',
    async () => {
      const { page } = await appAt(`/runs?q=${RUN.actions.runId}`);
      await page.waitForSelector('[role="rowheader"]', { timeout: 20_000 });

      const focusInside = (selector: string) =>
        page.evaluate((target) => document.activeElement?.closest(target) !== null, selector);
      for (let i = 0; i < 60 && !(await focusInside('[role="grid"] [role="row"]')); i++)
        await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-document="brief"]', { timeout: 20_000 });

      for (
        let i = 0;
        i < 120 && !(await focusInside('[data-document="brief"] button[data-citation]'));
        i++
      ) {
        await page.keyboard.press('Tab');
      }
      const chip = await page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? null,
      );
      expect(chip).not.toBeNull();
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () =>
          document.activeElement?.tagName === 'H2' &&
          document.activeElement.closest('aside') !== null,
      );
      await page.keyboard.press('Escape');

      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null),
      ).toBe(chip);
      await page.close();
    },
    TIMEOUT,
  );
});
