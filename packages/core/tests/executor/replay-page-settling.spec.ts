/**
 * Deterministic replay against a live page: settling and readable extraction.
 *
 * Two gaps this pins, both of which made a promoted workflow run green while
 * collecting nothing:
 *
 * 1. **Replay never waited for the page.** `handleClick` returned the instant
 *    `elementHandle.click()` resolved, so the next step read the pre-click
 *    document. The agent's own controller had ~60s of settling; the executor
 *    had none. On a real site — a carrier tracking page whose result arrives
 *    via a fetch seconds later — the extract captured an empty shell.
 * 2. **Extraction returned page chrome.** A page-level locator with
 *    `primitive/string` yields `textContent`, which concatenates nav, cookie
 *    banner, footer, and the source of every inline `<script>`.
 *
 * These run the real `Executor` against real Chrome, because both failures are
 * invisible to a fake page: a fake resolves instantly and has no script tags.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractStep, Plan, Step } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import { Executor } from '../../src/executor/executor.js';
import type { EthicsGate, ExecutionContext } from '../../src/executor/types.js';
import type { EngineLocatorChain } from '../../src/locator/types.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const permissiveEthics: EthicsGate = { check: () => Promise.resolve() };

/** How long after the click the fixture takes to paint its result. */
const RESULT_DELAY_MS = 1_500;

const LOCATORS: Record<string, EngineLocatorChain> = {
  track_button: {
    name: 'track_button',
    strict: true,
    candidates: [{ intent: { kind: 'role', role: 'button', name: 'Track' }, source: 'authored' }],
  },
  page_body: {
    name: 'page_body',
    strict: true,
    candidates: [{ intent: { kind: 'css', selector: 'body' }, source: 'authored' }],
  },
};

function step(partial: Partial<Step> & { id: string; type: Step['type'] }): Step {
  return { scope: null, requires_confirmation: false, ...partial } as Step;
}

function makePlan(steps: readonly Step[]): Plan {
  return {
    task_id: '01JEXAMPLETASKID0000000000',
    plan_id: '01JEXAMPLEPLANID0000000000',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps: [...steps],
    outputs: [],
  };
}

describe('@no-llm deterministic replay against a live page', () => {
  let server: Server;
  let baseUrl: string;
  let session: BrowserSession;
  let page: Page;
  const runDirs: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/result-fragment') {
        // Slower than any fixed post-click pause: only a real settling wait
        // covers it. Mirrors a tracking page whose status arrives via fetch.
        setTimeout(
          () => response.end('Delivered Monday, 07/21/2025 at 2:14 P.M. Left at: Front Door'),
          RESULT_DELAY_MS,
        );
        return;
      }
      if (path === '/app-shell') {
        // No prose for Readability to find — the shape of a real tracking
        // result, an order summary, or any app-like page. Readability returns
        // null here, which is exactly when the visible-text fallback matters.
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><title>App shell</title>
          <script>const HIDDEN_SCRIPT_TEXT = 1;</script>
          <div><span>Status</span><span>Delivered</span></div>
          <div style="display:none">HIDDEN_FROM_VIEW</div>
          <button>Refresh</button>`);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Tracking fixture</title>
        <nav>Skip to Main Content Login Shipping Support</nav>
        <script>window.dataLayer = []; function noise() { return 'INLINE_SCRIPT_NOISE'; }</script>
        <main>
          <article>
            <h1>Tracking</h1>
            <p id="out">Enter a tracking number to see its status here on this page.</p>
          </article>
        </main>
        <footer>Cookie preferences Terms of Use Privacy Notice</footer>
        <button id="track">Track</button>
        <script>document.getElementById('track').addEventListener('click', async () => {
          const res = await fetch('/result-fragment');
          document.getElementById('out').textContent = await res.text();
        });</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}/`;

    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true });
    // One page for the whole file: each test navigates it, so the suite runs a
    // single Chrome rather than one per case. Three concurrent Chromes across
    // the core suite push slower tests past the 15s timeout.
    page = await session.newPage();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  afterEach(async () => {
    await Promise.all(runDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Runs a plan against the shared page and returns the finished context.
   *
   * The context's settler is disposed afterwards: each context attaches its own
   * page listeners, and reusing one page across runs would otherwise stack them
   * up. Production never hits this — a run owns its page and closes it — but
   * the test does, and a leaked listener would silently skew later cases.
   */
  async function runPlan(
    steps: readonly Step[],
    outputs: Plan['outputs'] = [],
  ): Promise<{ ctx: ExecutionContext; runDir: string; status: string }> {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-replay-settle-'));
    runDirs.push(runDir);
    const ctx = createExecutionContext({
      taskId: '01JEXAMPLETASKID0000000000',
      plan: { ...makePlan(steps), outputs },
      runDir,
      browser: session,
      page,
      ethics: permissiveEthics,
      logger,
      workflowLocators: { resolve: (name) => LOCATORS[name] ?? null },
    });
    try {
      const outcome = await new Executor().run(ctx);
      return { ctx, runDir, status: outcome.status };
    } finally {
      ctx.settler?.dispose();
    }
  }

  it('waits for a fetch-driven result before extracting it', async () => {
    // Regression: without post-click settling this captured the placeholder
    // paragraph, because the click returned ~1.5s before the result painted.
    const { ctx, status } = await runPlan([
      step({ id: 's1', type: 'navigate', url: { kind: 'literal', value: baseUrl } }),
      step({
        id: 's2',
        type: 'click',
        locator: { kind: 'workflow', name: 'track_button' },
        modifiers: null,
      }),
      step({
        id: 's3',
        type: 'extract',
        locator: { kind: 'workflow', name: 'page_body' },
        extraction_schema: { type: 'primitive', kind: 'readable' },
        capture_as: 'page_content',
      } as Partial<ExtractStep> & { id: string; type: 'extract' }),
    ]);

    expect(status).toBe('completed');
    const captured = ctx.captures.get('page_content') as { rows: string[] };
    expect(captured.rows[0]).toContain('Delivered Monday');
    expect(captured.rows[0]).not.toContain('Enter a tracking number');
  }, 90_000);

  it('extracts readable content without page chrome or inline script source', async () => {
    const { ctx, status } = await runPlan([
      step({ id: 's1', type: 'navigate', url: { kind: 'literal', value: baseUrl } }),
      step({
        id: 's2',
        type: 'extract',
        locator: { kind: 'workflow', name: 'page_body' },
        extraction_schema: { type: 'primitive', kind: 'readable' },
        capture_as: 'page_content',
      } as Partial<ExtractStep> & { id: string; type: 'extract' }),
    ]);

    expect(status).toBe('completed');
    const text = (ctx.captures.get('page_content') as { rows: string[] }).rows[0]!;
    expect(text).toContain('Enter a tracking number');
    // The three things `textContent` on `body` would have dragged in.
    expect(text).not.toContain('INLINE_SCRIPT_NOISE');
    expect(text).not.toContain('Skip to Main Content');
    expect(text).not.toContain('Privacy Notice');
  }, 90_000);

  it('falls back to visible text on a page with no article to extract', async () => {
    // Readability targets prose documents and returns nothing for an app
    // shell. Without the fallback the terminal extract step would capture an
    // empty string on exactly the pages workflows are recorded against.
    const { ctx, status } = await runPlan([
      step({
        id: 's1',
        type: 'navigate',
        url: { kind: 'literal', value: `${baseUrl}app-shell` },
      }),
      step({
        id: 's2',
        type: 'extract',
        locator: { kind: 'workflow', name: 'page_body' },
        extraction_schema: { type: 'primitive', kind: 'readable' },
        capture_as: 'page_content',
      } as Partial<ExtractStep> & { id: string; type: 'extract' }),
    ]);

    expect(status).toBe('completed');
    const text = (ctx.captures.get('page_content') as { rows: string[] }).rows[0]!;
    expect(text).toContain('Delivered');
    // `innerText`, not `textContent`: script source and display:none stay out.
    expect(text).not.toContain('HIDDEN_SCRIPT_TEXT');
    expect(text).not.toContain('HIDDEN_FROM_VIEW');
  }, 90_000);

  it('still captures raw text when the schema asks for a plain string', async () => {
    // `readable` is opt-in; `string` must keep meaning "the element's text".
    const { ctx, status } = await runPlan([
      step({ id: 's1', type: 'navigate', url: { kind: 'literal', value: baseUrl } }),
      step({
        id: 's2',
        type: 'extract',
        locator: { kind: 'workflow', name: 'page_body' },
        extraction_schema: { type: 'primitive', kind: 'string' },
        capture_as: 'page_content',
      } as Partial<ExtractStep> & { id: string; type: 'extract' }),
    ]);

    expect(status).toBe('completed');
    const text = (ctx.captures.get('page_content') as { rows: string[] }).rows[0]!;
    expect(text).toContain('INLINE_SCRIPT_NOISE');
  }, 90_000);

  it('writes the extracted value into the run outputs', async () => {
    // A run that completes and reports nothing is indistinguishable from one
    // that did nothing.
    const { runDir, status } = await runPlan(
      [
        step({ id: 's1', type: 'navigate', url: { kind: 'literal', value: baseUrl } }),
        step({
          id: 's2',
          type: 'extract',
          locator: { kind: 'workflow', name: 'page_body' },
          extraction_schema: { type: 'primitive', kind: 'readable' },
          capture_as: 'page_content',
        } as Partial<ExtractStep> & { id: string; type: 'extract' }),
      ],
      [{ name: 'status', from: { step_id: 'page_content', field: null } }],
    );

    expect(status).toBe('completed');
    const outputs = JSON.parse(await readFile(join(runDir, 'outputs.json'), 'utf8')) as {
      status?: { rows?: string[] };
    };
    expect(outputs.status?.rows?.[0]).toContain('Enter a tracking number');
  }, 90_000);
});
