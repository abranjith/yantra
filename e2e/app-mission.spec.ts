/// <reference lib="dom" />
/**
 * @no-llm Mission end to end (FEAT-067 TASK-016, milestone M2).
 *
 * The built CLI starts a real host, real Chrome opens the app, and a real
 * `research --no-llm` is composed, started and followed to its result:
 *
 * 1. composed from the Mission page, run by a detached worker, followed in
 *    the cockpit, and finished into `/runs/<id>`;
 * 2. every event in its `run-events.jsonl` shown in an instrument or the
 *    inspector (counted against the file), unchanged across a reload;
 * 3. the CLI twin copied from the cockpit, run in the OS default shell
 *    through an argv-recording `yantra`, starts the identical command;
 * 4. each mode shows exactly the registry's applicable, app-surfaced, live
 *    options;
 * 5. the polite live region says nothing about tool calls and at most one
 *    thing per 2 s;
 * 6. axe-clean composer and cockpit, keyboard-only compose, submit and Stop,
 *    and no horizontal scroll at 320 CSS px or at 200% zoom.
 *
 * Runs in the `LLM_PROVIDER=none` dimension. The research run reaches the
 * real search provider (as the FEAT-065 M2 suite does) with tight limits; its
 * outcome may be fulfilled, partial or failed — what is asserted is that the
 * app tells the truth about it. A scripted fake-provider `do` cannot run in a
 * host-spawned worker (it is injected in-process only), so the `do` contract
 * ring and graceful Stop are covered by the route and unit suites.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProcessIdentity } from '@yantra/core';
import {
  APP_OPTION_EXEMPTIONS,
  COMMAND_REGISTRY,
  InvocationRecord,
  KNOWN_DEAD_OPTIONS,
  UiOpenResult,
  conditionHolds,
  expandOptions,
  findLeaf,
  parseRunEventLine,
} from '@yantra/protocol';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchGalleryBrowser } from './drshya/browser.js';
import { runAxe } from './drshya/capture.js';
import {
  IS_WINDOWS,
  findBash,
  findPowerShell,
  launcherEnv,
  readEcho,
  writeLaunchers,
} from './fixtures/argv-echo/shells.js';
import { identifyTestHost, stopTestHost } from './fixtures/host-process.js';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');
const RUN_TIMEOUT = 180_000;

declare global {
  interface Window {
    __announcements?: { at: number; text: string }[];
  }
}

let home: string;
let browser: Browser;
let page: Page;
let opened: UiOpenResult;
let hostIdentity: ProcessIdentity | undefined;
let origin: string;
let runId = '';
/** What the page did that a failure message should show. */
const diagnostics: string[] = [];

function openUrl(): UiOpenResult {
  const result = spawnSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
    env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', YANTRA_UI_ASSETS_DIR: '' },
    encoding: 'utf8',
  });
  return UiOpenResult.parse(JSON.parse(result.stdout));
}

/** Records every change of the cockpit's polite live region, from page load. */
async function recordAnnouncements(target: Page): Promise<void> {
  await target.evaluateOnNewDocument(() => {
    window.__announcements = [];
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const node =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        const region = node?.closest('[data-part="announcer"]');
        if (region === null || region === undefined) continue;
        const text = region.textContent ?? '';
        const last = window.__announcements?.at(-1);
        if (text !== '' && text !== last?.text)
          window.__announcements?.push({ at: performance.now(), text });
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

async function waitConnected(target: Page): Promise<void> {
  await target.waitForSelector('[role="status"][data-status="connected"]', { timeout: 20_000 });
}

/** Clicks the element whose accessible text matches `text` among `selector`. */
async function clickText(target: Page, selector: string, text: string): Promise<void> {
  const handles = await target.$$(selector);
  for (const handle of handles) {
    const content = await handle.evaluate((element) => element.textContent?.trim() ?? '');
    if (content === text) {
      await handle.click();
      return;
    }
  }
  throw new Error(`no ${selector} reading "${text}"`);
}

async function openOptions(target: Page): Promise<void> {
  // The trigger reads "Options (n)", and n changes once effective values arrive.
  await target.evaluate(() => {
    const trigger = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-composer] button'),
    ].find((button) => button.textContent?.trim().startsWith('Options'));
    if (trigger === undefined) throw new Error('no Options trigger');
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  });
  await target.waitForSelector('[data-part="fields"]', { visible: true });
}

/** registry applicable (deterministic: LLM_PROVIDER=none) ∩ app-surfaced − dead − secret input. */
function expectedFlags(path: string): string[] {
  const entry = findLeaf([path])!;
  return expandOptions(entry, COMMAND_REGISTRY.option_groups)
    .filter((spec) => spec.input.kind !== 'secret-input')
    .filter((spec) => !APP_OPTION_EXEMPTIONS.some((item) => item.long === spec.long))
    .filter(
      (spec) => !KNOWN_DEAD_OPTIONS.some((d) => d.command === entry.id && d.option === spec.long),
    )
    .filter((spec) => !(path === 'run' && spec.long === '--params'))
    .filter((spec) =>
      (spec.applicability ?? []).every((condition) =>
        conditionHolds(condition, {
          options: { format: 'terminal', llm: false },
          arguments: {},
          mode: 'deterministic',
        }),
      ),
    )
    .map((spec) => spec.long);
}

/** The run's committed events, in order. */
function recordedEvents(id: string): { seq: number; kind: string }[] {
  const text = readFileSync(join(home, 'data', 'runs', id, 'run-events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const item = parseRunEventLine(line);
      if (item.status === 'event') return [{ seq: item.record.seq, kind: item.record.event.kind }];
      if (item.status === 'unknown_kind') return [{ seq: item.seq, kind: item.kind }];
      return [];
    });
}

/** Where the app shows each kind (an independent oracle for the acceptance count). */
const TIMELINE_KINDS = new Set([
  'task_started',
  'step_started',
  'step_retry',
  'step_completed',
  'llm_step_skipped',
  'checkpoint_saved',
  'human_handoff_requested',
  'task_completed',
  'task_failed',
  'validation_failed',
  'scope_violation',
  'task_resumed',
  'chrome_drift_warning',
  'synthesis_completed',
  'research_hop_completed',
  'recovery',
  'tool_started',
  'run_warning',
  'artifact_saved',
  'search_completed',
  'source_fetched',
  'extract_completed',
  'synthesize_started',
]);
const INSPECTOR_KINDS = new Set([
  'assistant_text',
  'receipt_written',
  'event_omitted',
  'discovery_cycle_completed',
  'discovery_session_completed',
]);

function invocationFor(id: string): InvocationRecord {
  const dir = join(home, 'data', 'ui', 'invocations');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
    const record = InvocationRecord.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    if (record.run_id === id) return record;
  }
  throw new Error(`no invocation for ${id}`);
}

beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-mission-'));
  opened = openUrl();
  hostIdentity = await identifyTestHost(opened.hostPid);
  origin = `http://127.0.0.1:${opened.port}`;
  browser = await launchGalleryBrowser();
  page = await browser.newPage();
  page.on('error', (error) => diagnostics.push(`crash: ${error.message}`));
  page.on('pageerror', (error) =>
    diagnostics.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`),
  );
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) diagnostics.push(`navigated: ${frame.url()}`);
  });
  await recordAnnouncements(page);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (hostIdentity !== undefined) await stopTestHost(hostIdentity);
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('@no-llm Mission, end to end', () => {
  it(
    'shows each mode’s applicable options, then runs research --no-llm from the composer to its result',
    async () => {
      await page.goto(opened.url);
      await waitConnected(page);
      await page.waitForSelector('[data-part="composer"]');
      expect(new URL(page.url()).pathname).toBe('/mission');
      expect(await runAxe(page, 'main')).toEqual([]);

      // 4. No inapplicable option appears, in any mode.
      for (const [label, path] of [
        ['Ask', 'ask'],
        ['Research', 'research'],
        ['Do', 'do'],
        ['Run', 'run'],
      ] as const) {
        await clickText(page, '[role="tab"]', label);
        await page.waitForSelector(`[data-composer="${path}"]`);
        await openOptions(page);
        await page.waitForFunction(
          (count) => document.querySelectorAll('[data-composer] [data-field]').length === count,
          { timeout: 10_000 },
          expectedFlags(path).length,
        );
        const shown = await page.$$eval('[data-composer] [data-field]', (nodes) =>
          nodes.map((node) => (node as HTMLElement).dataset.field ?? ''),
        );
        expect({ path, shown }).toEqual({ path, shown: expectedFlags(path) });
      }

      // 1. Compose and start a research run.
      await clickText(page, '[role="tab"]', 'Research');
      await page.waitForSelector('[data-composer="research"] textarea');
      await page.type('[data-composer="research"] textarea', 'quiet laptops for travel');
      await openOptions(page);
      await page.type('[data-field="--max-sources"] input', '2');
      await page.type('[data-field="--pipeline-timeout"] input', '20s');
      await clickText(page, '[data-composer="research"] button', 'Start');

      await page
        .waitForFunction(() => location.pathname.startsWith('/mission/'), { timeout: 30_000 })
        .catch(async (error: unknown) => {
          // Say why the composer did not submit: its inline refusal or field errors.
          const why = await page.evaluate(() =>
            [...document.querySelectorAll('[role="alert"], [data-composer] [slot="errorMessage"]')]
              .map((node) => node.textContent)
              .join(' | '),
          );
          throw new Error(`the composer did not submit: ${why}`, { cause: error });
        });
      await page
        .waitForFunction(() => /^\/runs\/[^/]+$/u.test(location.pathname), { timeout: RUN_TIMEOUT })
        .catch(async (error: unknown) => {
          const where = await page
            .evaluate(
              () =>
                `${location.pathname} | ${document.querySelector('[aria-label^="Run status"]')?.textContent ?? ''}`,
            )
            .catch(() => 'page gone');
          throw new Error(
            `the run did not finish into its result: ${where}\n${diagnostics.slice(-15).join('\n')}`,
            { cause: error },
          );
        });
      runId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]!);
      await page
        .waitForSelector('[data-focus-target="run-heading"]', { timeout: 30_000 })
        .catch(async (error: unknown) => {
          const text = await page.evaluate(
            () => document.querySelector('main')?.textContent?.slice(0, 400) ?? '',
          );
          throw new Error(
            `the run result did not render: ${text}\n${diagnostics.slice(-10).join('\n')}`,
            {
              cause: error,
            },
          );
        });

      const events = recordedEvents(runId);
      expect(events.filter((event) => event.kind === 'run_outcome')).toHaveLength(1);
      expect(invocationFor(runId).invocation.argv).toEqual([
        'quiet laptops for travel',
        '--max-sources',
        '2',
        '--pipeline-timeout',
        '20s',
      ]);

      // 5. Polite, paced, and never about tool calls.
      const said = await page.evaluate(() => window.__announcements ?? []);
      expect(said.length).toBeGreaterThan(0);
      expect(said.some((item) => item.text.includes('Run finished:'))).toBe(true);
      for (const [index, item] of said.entries()) {
        expect(item.text).not.toMatch(/tool|search |fetch /u);
        if (index > 0) expect(item.at - said[index - 1]!.at).toBeGreaterThanOrEqual(1_900);
      }
    },
    RUN_TIMEOUT + 60_000,
  );

  it('shows every recorded event, unchanged across a reload, and its CLI twin runs the same command', async () => {
    expect(runId).not.toBe('');
    const launched = invocationFor(runId);
    await page.goto(
      `${origin}/mission/runs/${runId}?invocation=${launched.invocation_id}&mode=research`,
    );
    await waitConnected(page);
    const events = recordedEvents(runId);
    const lastTimeline = events.filter((event) => TIMELINE_KINDS.has(event.kind)).at(-1)?.seq ?? 0;
    await page.waitForSelector(
      `[data-instrument="timeline"] [data-seq="${String(lastTimeline)}"]`,
      {
        timeout: 30_000,
      },
    );

    // 2. Every event has a place: the timeline, the inspector, or its instrument.
    const shownSeqs = async (): Promise<number[]> =>
      page.$$eval('[data-instrument="timeline"] [data-seq]', (rows) =>
        rows.map((row) => Number((row as HTMLElement).dataset.seq)),
      );
    const timeline = await shownSeqs();
    const inspectorText = await page
      .$eval('[data-instrument="inspector"]', (node) => node.textContent ?? '')
      .catch(() => '');
    const inspected = Number(/Other events \((\d+)\)/u.exec(inspectorText)?.[1] ?? '0');
    // A finished tool call shares its start's row.
    expect(timeline).toEqual(
      events.filter((event) => TIMELINE_KINDS.has(event.kind)).map((event) => event.seq),
    );
    expect(inspected).toBe(events.filter((event) => INSPECTOR_KINDS.has(event.kind)).length);
    for (const event of events) {
      if (TIMELINE_KINDS.has(event.kind) || INSPECTOR_KINDS.has(event.kind)) continue;
      if (event.kind === 'tool_finished') continue;
      if (event.kind === 'goal_echo') {
        expect(await page.$eval('[data-part="goal"]', (node) => node.textContent)).toContain(
          'quiet laptops',
        );
      } else if (event.kind === 'budget_snapshot') {
        expect((await page.$$('[data-instrument="budgets"] [data-budget]')).length).toBeGreaterThan(
          0,
        );
      } else if (event.kind === 'run_outcome') {
        expect(await page.$('[aria-label="Run status: finished"]')).not.toBeNull();
      } else {
        throw new Error(`no instrument check for ${event.kind}`);
      }
    }

    // 3. A reload resumes with no gap or duplicate.
    await page.reload();
    await waitConnected(page);
    await page.waitForSelector(
      `[data-instrument="timeline"] [data-seq="${String(lastTimeline)}"]`,
      {
        timeout: 30_000,
      },
    );
    expect(await shownSeqs()).toEqual(timeline);

    // Twin: the copied command, run in the OS default shell, starts the identical command.
    const twin = await page.$eval(
      '[data-instrument="cli-twin"] [data-part="command"]',
      (node) => node.textContent ?? '',
    );
    const record = invocationFor(runId);
    const work = mkdtempSync(join(tmpdir(), 'yantra-twin-'));
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeLaunchers(bin);
    const out = join(work, 'argv.json');
    if (IS_WINDOWS) {
      const powershell = findPowerShell();
      expect(powershell).not.toBeNull();
      const script = join(work, 'twin.ps1');
      writeFileSync(script, `\uFEFF$env:ARGV_ECHO_OUT = '${out}'\r\n${twin}\r\n`, 'utf8');
      spawnSync(
        powershell!,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          env: launcherEnv(bin),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
    } else {
      const bash = findBash();
      expect(bash).not.toBeNull();
      const script = join(work, 'twin.sh');
      writeFileSync(script, `export ARGV_ECHO_OUT='${out}'\n${twin}\n`);
      spawnSync(bash!, ['--noprofile', '--norc', script], {
        env: launcherEnv(bin),
        encoding: 'utf8',
        timeout: 60_000,
      });
    }
    expect(readEcho(out)).toEqual([...record.invocation.path, ...record.invocation.argv]);
    rmSync(work, { recursive: true, force: true });

    // Accessibility of the finished cockpit.
    expect(await runAxe(page, 'main')).toEqual([]);
  }, 120_000);

  it(
    'can be composed, started and stopped with the keyboard alone, and reflows at 320 px and 200% zoom',
    async () => {
      await page.goto(`${origin}/mission`);
      await waitConnected(page);
      await page.waitForSelector('[data-composer="ask"]');
      // Keyboard only: Research, the topic, No LLM is already in force (LLM_PROVIDER=none), Start.
      await page.focus('[role="tab"]');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-composer="research"]');
      for (let step = 0; step < 10; step += 1) {
        const onTopic = await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA');
        if (onTopic) break;
        await page.keyboard.press('Tab');
      }
      await page.keyboard.type('electric bikes');
      for (let step = 0; step < 60; step += 1) {
        const onStart = await page.evaluate(
          () => document.activeElement?.textContent?.trim() === 'Start',
        );
        if (onStart) break;
        await page.keyboard.press('Tab');
      }
      await page.keyboard.press('Enter');
      await page
        .waitForFunction(() => location.pathname.startsWith('/mission/runs/'), { timeout: 120_000 })
        .catch(async (error: unknown) => {
          const where = await page
            .evaluate(
              () =>
                `${location.pathname} | ${document.activeElement?.outerHTML.slice(0, 120) ?? ''} | ${
                  document.querySelector('main')?.textContent?.slice(0, 300) ?? ''
                }`,
            )
            .catch(() => 'frame gone');
          const records = readdirSync(join(home, 'data', 'ui', 'invocations'))
            .filter((name) => name.endsWith('.json') && !name.endsWith('.result.json'))
            .map((name) => {
              const record = InvocationRecord.parse(
                JSON.parse(readFileSync(join(home, 'data', 'ui', 'invocations', name), 'utf8')),
              );
              return `${record.invocation_id}:${record.state}:${record.run_id ?? '-'}`;
            })
            .join(', ');
          throw new Error(
            `the keyboard submit did not start a run: ${where} | invocations ${records}\n${diagnostics.slice(-12).join('\n')}`,
            { cause: error },
          );
        });

      // The run ID now, while the cockpit is open: a quick run may finish into /runs/<id> below.
      const stoppedRun = decodeURIComponent(new URL(page.url()).pathname.split('/')[3]!);
      // Stop on research --no-llm reads as a forced stop, by keyboard.
      const stopLabel = await page
        .waitForSelector('[data-stop]', { timeout: 30_000 })
        .then((handle) => handle?.evaluate((node) => node.textContent?.trim() ?? '') ?? null)
        .catch(() => null);
      if (stopLabel !== null) {
        expect(stopLabel).toBe('Stop (force)');
        await page.focus('[data-stop]');
        await page.keyboard.press('Enter');
      }
      await page.waitForFunction(
        () =>
          location.pathname.startsWith('/runs/') ||
          document.querySelector('[aria-label="Run status: finished"]') !== null,
        { timeout: RUN_TIMEOUT },
      );
      // Exactly one terminal result, whichever way it ended.
      expect(
        recordedEvents(stoppedRun).filter((event) => event.kind === 'run_outcome'),
      ).toHaveLength(1);

      // Reflow: no horizontal scroll at 320 CSS px, nor at 200% zoom of a 1280 px window.
      for (const width of [320, 640]) {
        await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
        await page.goto(`${origin}/mission`);
        await waitConnected(page);
        await page.waitForSelector('[data-part="composer"]');
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect({ width, overflow }).toEqual({ width, overflow: 0 });
      }
    },
    RUN_TIMEOUT + 120_000,
  );
});
