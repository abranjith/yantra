/// <reference lib="dom" />
/**
 * FEAT-069 TASK-012: the live view in a real app window.
 *
 * `yantra ui` starts the real host. A Chrome app page opens the cockpit of a
 * deterministic `run` launched through `command.invoke`, and the detached
 * worker streams its task page over the real run socket, host relay and
 * WebSocket into the real BrowserViewport canvas. The page is instrumented
 * from the test only (draws, clears, viewport state changes); nothing in the
 * product is test-aware.
 *
 * The workflow fills a password field with a literal (a masked-value fill;
 * focus then stays in the protected field), waits, then moves to a moving
 * page for the performance window. Asserted (plan §10 and §12):
 * - the viewport went `protected` and the canvas was cleared no later than
 *   that change;
 * - nothing was drawn while protected;
 * - on the motion page the window drew at 5 fps or more with the app's main
 *   thread under 15% of one core, or the cockpit switched itself to Solid;
 * - the run directory and host.log hold no frame bytes.
 *
 * Requires built packages (`npx turbo run build`): the suite runs the built CLI.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FileWorkflowStore, resetPathCache, workflowsRoot } from '@yantra/core';
import { InvocationRecord, UiOpenResult, generateUlid, type WorkflowFile } from '@yantra/protocol';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { launchGalleryBrowser } from './drshya/browser.js';
import { serveFixtureSite, type FixtureServer } from './fixtures/serve.js';
import { scanForFrames } from './live-view/privacy-scan.js';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');
const WORKFLOW = 'live-view-window';
/** Budget from plan §10 and the S1 report. */
const MIN_FPS = 5;
const MAX_SHARE = 0.15;

let home: string;
let site: FixtureServer;
let browser: Browser;
const hostPids: number[] = [];
let previousHome: string | undefined;

function env(): NodeJS.ProcessEnv {
  return { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', YANTRA_UI_ASSETS_DIR: '' };
}

function openUi(): UiOpenResult {
  const opened = UiOpenResult.parse(
    JSON.parse(
      execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
        env: env(),
        encoding: 'utf8',
      }),
    ),
  );
  hostPids.push(opened.hostPid);
  return opened;
}

/** Exchanges a launch code for a session the way the page does. */
function exchange(port: number, code: string): Promise<{ cookie: string; capability: string }> {
  return new Promise((done, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/session',
        agent: false,
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          const cookie = /yantra_session=([^;]+)/u.exec(res.headers['set-cookie']?.[0] ?? '')?.[1];
          const grant = JSON.parse(body) as { window_capability?: string };
          if (cookie === undefined || grant.window_capability === undefined)
            reject(new Error(body));
          else done({ cookie, capability: grant.window_capability });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

/** Launches the workflow through a second, Node-side window: `command.invoke`. */
async function invokeRun(url: string): Promise<string> {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  const { cookie, capability } = await exchange(port, parsed.hash.slice('#code='.length));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    origin: `http://127.0.0.1:${port}`,
    headers: { cookie: `yantra_session=${cookie}` },
  });
  ws.on('error', () => undefined);
  await new Promise<void>((done, reject) => {
    ws.once('open', () => done());
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({ jsonrpc: '2.0', method: 'auth', params: { window_capability: capability } }),
  );
  const id = generateUlid();
  const reply = await new Promise<Record<string, unknown>>((done) => {
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (message.id === 1) done(message);
    });
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'command.invoke',
        params: {
          invocation: { invocation_id: id, path: ['run'], argv: [WORKFLOW], cwd: home },
          displayed_effective: { settings: [], content: [] },
        },
      }),
    );
  });
  ws.close();
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error));
  return id;
}

function invocation(id: string): InvocationRecord | null {
  const path = join(home, 'data', 'ui', 'invocations', `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return InvocationRecord.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

async function until<T>(
  read: () => T | null | undefined | false,
  ms: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

function step(id: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    ...body,
  };
}

function workflow(base: string): WorkflowFile {
  return {
    version: 1,
    name: WORKFLOW,
    description: 'FEAT-069 live view evidence',
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      step('s1', { verb: 'navigate', url: `${base}/live-view/login.html` }),
      step('s2', { verb: 'wait_for', locator: 'Ready', state: 'visible', timeout_ms: 20_000 }),
      step('s3', {
        verb: 'fill_element',
        field_name: 'Password',
        locator: 'Password',
        value: 'Synthetic-live-view-pw',
      }),
      step('s4', { verb: 'wait_for', locator: 'After', state: 'visible', timeout_ms: 20_000 }),
      step('s5', { verb: 'navigate', url: `${base}/live-view/motion.html` }),
      step('s6', { verb: 'wait_for', locator: 'Late', state: 'visible', timeout_ms: 30_000 }),
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {
      Ready: [{ kind: 'css', value: '#ready' }],
      Password: [{ kind: 'css', value: '#password' }],
      After: [{ kind: 'css', value: '#after' }],
      Late: [{ kind: 'css', value: '#late' }],
    },
  } as unknown as WorkflowFile;
}

/** What the page recorded: draws and clears on the viewport canvas, and its state changes. */
interface Recorded {
  readonly draws: number[];
  readonly clears: number[];
  readonly states: [string, number][];
  readonly solid: boolean;
}

/** Installed before any app script: counts viewport canvas operations, and state changes. */
function instrument(): void {
  const log = { draws: [] as number[], clears: [] as number[], states: [] as [string, number][] };
  (window as unknown as { __liveView: typeof log }).__liveView = log;
  const onViewport = (canvas: HTMLCanvasElement): boolean =>
    canvas.closest('[data-instrument="browser-viewport"]') !== null;
  const proto = CanvasRenderingContext2D.prototype;
  const wrap = (name: 'drawImage' | 'clearRect', into: number[]): void => {
    const original = Object.getOwnPropertyDescriptor(proto, name)?.value as (
      ...args: unknown[]
    ) => unknown;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (this: CanvasRenderingContext2D, ...args: unknown[]): unknown {
        if (onViewport(this.canvas)) into.push(performance.now());
        return Reflect.apply(original, this, args);
      },
    });
  };
  wrap('drawImage', log.draws);
  wrap('clearRect', log.clears);
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Element;
      if (target.getAttribute('data-instrument') === 'browser-viewport') {
        log.states.push([target.getAttribute('data-state') ?? '', performance.now()]);
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          const viewport = node.matches('[data-instrument="browser-viewport"]')
            ? node
            : node.querySelector('[data-instrument="browser-viewport"]');
          if (viewport !== null) {
            log.states.push([viewport.getAttribute('data-state') ?? '', performance.now()]);
          }
        }
      }
    }
  }).observe(document, { subtree: true, childList: true });
}

async function recorded(page: Page): Promise<Recorded> {
  return page.evaluate(() => {
    const log = (
      window as unknown as {
        __liveView: { draws: number[]; clears: number[]; states: [string, number][] };
      }
    ).__liveView;
    return {
      draws: [...log.draws],
      clears: [...log.clears],
      states: [...log.states],
      solid:
        document.querySelector('[data-part="cockpit"]')?.getAttribute('data-surfaces') === 'solid',
    };
  });
}

async function taskDuration(cdp: CDPSession): Promise<{ busy: number; at: number }> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const read = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { busy: read('TaskDuration'), at: read('Timestamp') };
}

beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-live-view-'));
  previousHome = process.env.YANTRA_HOME;
  process.env.YANTRA_HOME = home;
  resetPathCache();
  site = await serveFixtureSite();
  await new FileWorkflowStore(workflowsRoot()).save(workflow(site.baseUrl));
  browser = await launchGalleryBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const pid of hostPids) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  await site?.close();
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  await new Promise((done) => setTimeout(done, 1_500));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('@no-llm live browser view in a real app window', () => {
  it('hides a protected screen, never draws it, and holds the frame budget (or switches to Solid)', async () => {
    // Arrange: a real host, the app page instrumented before its scripts run.
    const opened = openUi();
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(instrument);
    await page.goto(opened.url);
    await page.waitForSelector('[role="status"][data-status="connected"]', { timeout: 20_000 });
    const origin = new URL(opened.url).origin;

    // Act: launch the run and open its cockpit in this window.
    const id = await invokeRun(openUi().url);
    // Straight to the run's cockpit: the invocation page's redirect is not what is tested here.
    const runId = await until(() => invocation(id)?.run_id, 60_000, 'the worker to own its run');
    await page.goto(`${origin}/mission/runs/${runId}?invocation=${id}&mode=run`);
    await page
      .waitForSelector('[data-instrument="browser-viewport"][data-state="live"]', {
        timeout: 60_000,
      })
      .catch(async (error: unknown) => {
        const seen = await recorded(page).catch(() => null);
        const text = await page
          .evaluate(() => document.querySelector('main')?.textContent?.slice(0, 600) ?? '')
          .catch(() => '');
        throw new Error(
          `never live: ${page.url()} ${JSON.stringify(seen?.states)} | ${text} | ${JSON.stringify(invocation(id))}`,
          { cause: error },
        );
      });

    // The password fill: the view must go protected.
    await page.waitForSelector('[data-instrument="browser-viewport"][data-state="protected"]', {
      timeout: 60_000,
    });
    // Then the motion page streams live again.
    await page.waitForFunction(
      () => {
        const log = (window as unknown as { __liveView: { states: [string, number][] } })
          .__liveView;
        const states = log.states.map(([state]) => state);
        return states.lastIndexOf('live') > states.lastIndexOf('protected');
      },
      { timeout: 60_000 },
    );

    // Performance window on the motion page, measured on the app target.
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    const before = await taskDuration(cdp);
    const drawsBefore = (await recorded(page)).draws.length;
    const windowStart = Date.now();
    await new Promise((done) => setTimeout(done, 5_000));
    const after = await taskDuration(cdp);
    const log = await recorded(page);
    const seconds = (Date.now() - windowStart) / 1000;
    const fps = (log.draws.length - drawsBefore) / seconds;
    const share = (after.busy - before.busy) / (after.at - before.at);

    // Assert 1: every protected interval was cleared at its start and drew nothing.
    const intervals: [number, number][] = [];
    for (const [index, [state, at]] of log.states.entries()) {
      if (state !== 'protected') continue;
      const end = log.states.slice(index + 1).find(([next]) => next !== 'protected')?.[1];
      intervals.push([at, end ?? Number.POSITIVE_INFINITY]);
    }
    const passwordInterval = intervals.at(-1);
    expect(passwordInterval).toBeDefined();
    for (const [start, end] of intervals) {
      expect(log.draws.filter((at) => at > start && at < end)).toEqual([]);
      // The store clears the canvas in the same tick it switches state.
      expect(log.clears.some((at) => at <= start + 50)).toBe(true);
    }

    // Assert 2: the budget held, or the cockpit switched itself to Solid.
    const budget = { fps, share, solid: log.solid };
    // The object is in the assertion so a failure reports the measured numbers.
    expect({
      ...budget,
      within: budget.solid || (budget.fps >= MIN_FPS && budget.share < MAX_SHARE),
    }).toMatchObject({ within: true });

    // Assert 3: no frame bytes in the run directory or host.log once the run ends.
    await until(() => invocation(id)?.state === 'finished', 90_000, 'the run to finish');
    expect(scanForFrames(join(home, 'data', 'runs', runId))).toEqual([]);
    expect(
      scanForFrames(join(home, 'data', 'ui')).filter((leak) => leak.path === 'host.log'),
    ).toEqual([]);
    await page.close();
  }, 240_000);
});
