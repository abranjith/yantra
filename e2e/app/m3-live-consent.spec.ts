/**
 * @no-llm REV-009: M3 consent on a live run (plan §8 M3, §10 B2).
 *
 * The parked-consent suite (`m3-consent.spec.ts`) never reaches a live
 * owner. Here the real built host launches a deterministic workflow through
 * `command.invoke`; its detached worker owns the run, and its second
 * navigation waits for consent. The answers then go where a user's would:
 * - the Inbox, from a window that is not following the run (the host has no
 *   attachment, so it must reach the owner over the run socket itself);
 * - `yantra confirm`, against the live owner;
 * - the app again after `yantra confirm`, from a fresh connection (a
 *   reconnect), which must be told the request is already decided.
 * Each request ends with exactly one decision and the right `decided_by`, and
 * no parked claim is ever written for a live run.
 *
 * Racing timeouts are covered against the authority itself (core tests); an
 * agentic `do` needs a model, so its live answers are covered on the real
 * run socket in `packages/agent` and `packages/core` tests.
 *
 * Requires built packages (`npx turbo run build`): the suite runs the built CLI.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { FileWorkflowStore, resetPathCache, workflowsRoot } from '@yantra/core';
import {
  InvocationRecord,
  UiOpenResult,
  generateUlid,
  type DecisionResponse,
  type InboxItem,
  type WorkflowFile,
} from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { serveFixtureSite, type FixtureServer } from '../fixtures/serve.js';

const execFileAsync = promisify(execFile);
const BIN = resolve(import.meta.dirname, '..', '..', 'apps', 'cli', 'dist', 'bin.js');
const WORKFLOW = 'live-consent';
const WAIT = 60_000;

let home: string;
let site: FixtureServer;
let previousHome: string | undefined;
const hostPids: number[] = [];

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

/** One authenticated app window, Node-side: it never follows a run. */
class Window {
  private next = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (typeof message.id === 'number') this.pending.get(message.id)?.(message);
    });
  }

  public static async open(): Promise<Window> {
    const url = new URL(openUi().url);
    const port = Number(url.port);
    const { cookie, capability } = await exchange(port, url.hash.slice('#code='.length));
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
    return new Window(ws);
  }

  /** Calls `method`; resolves the result, or rejects with the error object. */
  public call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise((done, reject) => {
      this.pending.set(id, (message) => {
        this.pending.delete(id);
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
        else done(message.result as T);
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  public close(): void {
    this.ws.close();
  }
}

async function launch(window: Window): Promise<string> {
  const id = generateUlid();
  await window.call('command.invoke', {
    invocation: { invocation_id: id, path: ['run'], argv: [WORKFLOW], cwd: home },
    displayed_effective: { settings: [], content: [] },
  });
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
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  ms: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** The run's live consent, as the Inbox lists it. */
async function liveConsent(window: Window, runId: string, id: string): Promise<InboxItem> {
  let last: InboxItem[] = [];
  return until(
    async () => {
      const { items } = await window.call<{ items: InboxItem[] }>('inbox.list', { limit: 200 });
      last = items;
      return items.find((item) => item.run_id === runId && item.kind === 'consent_live');
    },
    WAIT,
    `the live consent of ${runId} in the Inbox`,
  ).catch((error: unknown) => {
    // Names what the run did instead, so a failure is diagnosable.
    const dir = runDir(runId);
    const read = (name: string) =>
      existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').slice(-1500) : '(none)';
    throw new Error(
      [
        `inbox: ${JSON.stringify(last.map((item) => [item.kind, item.run_id]))}`,
        `invocation: ${JSON.stringify(invocation(id))}`,
        `files: ${existsSync(dir) ? readdirSync(dir).join(', ') : '(no run dir)'}`,
        `confirmations: ${read('confirmations.jsonl')}`,
        `interventions: ${read('interventions.jsonl')}`,
        `report: ${read('report.md')}`,
      ].join('\n'),
      { cause: error },
    );
  });
}

function runDir(runId: string): string {
  return join(home, 'data', 'runs', runId);
}

function decisions(runId: string): { decision: string; decided_by: string }[] {
  const path = join(runDir(runId), 'confirmations.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => typeof entry.decision === 'string')
    .map((entry) => ({ decision: String(entry.decision), decided_by: String(entry.decided_by) }));
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
    description: 'REV-009 live consent evidence',
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [
      step('s1', { verb: 'navigate', url: `${base}/live-view/login.html` }),
      step('s2', {
        verb: 'navigate',
        url: `${base}/live-view/second.html`,
        requires_confirmation: true,
        confirmation_description: 'Open the second fixture page',
        consequence: 'reversible',
      }),
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
  } as unknown as WorkflowFile;
}

beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-live-consent-'));
  previousHome = process.env.YANTRA_HOME;
  process.env.YANTRA_HOME = home;
  resetPathCache();
  site = await serveFixtureSite();
  await new FileWorkflowStore(workflowsRoot()).save(workflow(site.baseUrl));
}, 60_000);

afterAll(async () => {
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

describe('@no-llm M3 consent on a live run (REV-009)', () => {
  it('an Inbox answer from a window that does not follow the run decides it once, live', async () => {
    const window = await Window.open();
    try {
      const id = await launch(window);
      const runId = await until(() => invocation(id)?.run_id, WAIT, 'the worker to own its run');
      const item = await liveConsent(window, runId, id);

      const response = await window.call<DecisionResponse>('intervention.answer', {
        run_id: runId,
        intervention_id: item.intervention!.intervention_id,
        decision: 'granted',
      });

      expect(response).toMatchObject({
        status: 'accepted',
        decision: { decision: 'granted', decided_by: 'user_app' },
      });
      const done = await until(
        () => (invocation(id)?.state === 'finished' ? invocation(id) : null),
        WAIT,
        'the run to finish',
      );
      expect(done.result?.exit_code).toBe(0);
      expect(decisions(runId)).toEqual([{ decision: 'granted', decided_by: 'user_app' }]);
      // A live owner decided: no parked claim exists.
      expect(existsSync(join(runDir(runId), 'decisions'))).toBe(false);
    } finally {
      window.close();
    }
  }, 180_000);

  it('yantra confirm decides a live consent, and a reconnecting app answer is already decided', async () => {
    const window = await Window.open();
    try {
      const id = await launch(window);
      const runId = await until(() => invocation(id)?.run_id, WAIT, 'the worker to own its run');
      const item = await liveConsent(window, runId, id);

      const confirm = await execFileAsync(
        process.execPath,
        [BIN, 'confirm', runId, 'deny', '--json'],
        { env: env(), encoding: 'utf8' },
      );
      const confirmed = JSON.parse(confirm.stdout) as { case: string; response: DecisionResponse };
      expect(confirmed).toMatchObject({
        case: 'live',
        response: { status: 'accepted', decision: { decision: 'denied' } },
      });

      // The same window's socket goes away; a fresh one answers the same request.
      window.close();
      const again = await Window.open();
      try {
        const late = await again.call<DecisionResponse>('intervention.answer', {
          run_id: runId,
          intervention_id: item.intervention!.intervention_id,
          decision: 'granted',
        });
        expect(late).toMatchObject({
          status: 'already_decided',
          decision: 'denied',
          decided_by: 'user_cli_confirm',
        });
      } finally {
        again.close();
      }

      await until(() => invocation(id)?.state === 'finished', WAIT, 'the run to finish');
      expect(decisions(runId)).toEqual([{ decision: 'denied', decided_by: 'user_cli_confirm' }]);
      expect(existsSync(join(runDir(runId), 'decisions'))).toBe(false);
    } finally {
      window.close();
    }
  }, 180_000);
});
