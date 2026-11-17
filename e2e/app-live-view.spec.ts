/**
 * FEAT-069 TASK-012: screencast evidence (plan §10 "Screencast (I8)") and the
 * §12 acceptance items, over the real pipeline: real Chrome, the real focus
 * guard, screencast, hub and run socket, and the real host relay
 * (`live-view/rig.ts`). Each case states which acceptance item it backs.
 *
 * Requires built packages (memory: e2e resolves core from `dist/`):
 * `npx turbo run build` first.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Executor,
  LiveViewHub,
  LocalBrowserProvider,
  LocalProfileStore,
  createExecutionContext,
  type Logger,
  type TaskPageEvent,
} from '@yantra/core';
import { LocalRunStore, RunOrchestrator } from '@yantra/core/workflow/replay';
import { SCHEMA_VERSION, ok, type Plan, type Step, type WorkflowFile } from '@yantra/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { serveFixtureSite, type FixtureServer } from './fixtures/serve.js';
import { arrivalRate, scanForFrames } from './live-view/privacy-scan.js';
import { openRig, until, type RecordingWindow, type Rig } from './live-view/rig.js';

const CASE_TIMEOUT = 90_000;
const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

let site: FixtureServer;
let rig: Rig | null = null;

beforeAll(async () => {
  site = await serveFixtureSite();
});

afterAll(async () => {
  await site.close();
});

afterEach(async () => {
  await rig?.close();
  rig = null;
});

const url = (path: string): string => `${site.baseUrl}/live-view/${path}`;

/**
 * Index of the first `cleared` entry at or after `since` (ms), or -1. Every
 * stream starts with one of its own: a fresh focus guard reports `unknown`
 * until its first read, so the view begins hidden (fail closed).
 */
function clearedIndex(window: RecordingWindow, since: number): number {
  return window.entries.findIndex((entry) => entry.kind === 'cleared' && entry.at >= since);
}

/** Frames that arrived after entry `index`. */
function framesAfter(window: RecordingWindow, index: number) {
  return window.entries.slice(index + 1).filter((entry) => entry.kind === 'frame');
}

/** Waits for `count` more frames than the window has now. */
async function moreFrames(
  window: RecordingWindow,
  count: number,
  timeoutMs = 15_000,
): Promise<void> {
  const target = window.frames().length + count;
  await until(
    () => window.frames().length >= target,
    timeoutMs,
    () => JSON.stringify(window.entries.slice(-5)),
  );
}

describe('@no-llm live browser view: screencast evidence (I8)', () => {
  it(
    'never delivers a frame captured before protection began, even when the worker delays it',
    async () => {
      rig = await openRig({ delayFramesMs: 400 });
      await rig.controller.navigate(url('motion.html'));
      const window = rig.openWindow();
      await moreFrames(window, 3);

      const latchedAt = Date.now();
      rig.controller.sensitiveScreenLatch.latch(rig.controller.topLevelDocumentEpoch());
      await until(() => clearedIndex(window, latchedAt) >= 0);
      // Frames captured before the latch are still in flight at the worker: let them land.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const cleared = window.entries[clearedIndex(window, latchedAt)] as { generation: number };
      expect(framesAfter(window, clearedIndex(window, latchedAt))).toEqual([]);
      expect(rig.hub.droppedFrames.protected).toBeGreaterThan(0);
      expect(window.lastState()).toMatchObject({ state: 'protected', page: null });

      // A new document clears the latch; frames resume only from fresh captures.
      const clearedAt = Date.now();
      await rig.controller.navigate(url('second.html'));
      await moreFrames(window, 2);
      const resumed = framesAfter(window, clearedIndex(window, latchedAt));
      expect(resumed.length).toBeGreaterThan(0);
      for (const frame of resumed) {
        expect(frame.generation).toBeGreaterThan(cleared.generation);
        expect(frame.capturedAt).toBeGreaterThanOrEqual(clearedAt);
      }
      expect(latchedAt).toBeLessThan(clearedAt);
    },
    CASE_TIMEOUT,
  );

  it(
    'stops the old document’s frames on navigation; the first new-generation frame is a post-commit capture',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('motion.html'));
      const window = rig.openWindow();
      await moreFrames(window, 3);
      const before = Math.max(...window.frames().map((frame) => frame.generation));

      const navigatedAt = Date.now();
      await rig.controller.navigate(url('second.html'));
      await moreFrames(window, 3);
      const newer = window.frames().filter((frame) => frame.generation > before);
      expect(newer.length).toBeGreaterThan(0);
      expect(newer[0]!.capturedAt).toBeGreaterThanOrEqual(navigatedAt);
      // Generations only rise in arrival order.
      const order = window.frames().map((frame) => frame.generation);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(window.lastState()).toMatchObject({
        state: 'live',
        page: { title: 'Live view second fixture' },
      });
    },
    CASE_TIMEOUT,
  );

  it(
    'after a dropped window reconnects during protection it gets the protected state and no frame',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('motion.html'));
      const first = rig.openWindow();
      await moreFrames(first, 2);
      const latchedAt = Date.now();
      rig.controller.sensitiveScreenLatch.latch(rig.controller.topLevelDocumentEpoch());
      await until(() => clearedIndex(first, latchedAt) >= 0);
      first.close();

      const reconnected = rig.openWindow();
      // A fresh watch learns the worker's state right after frames.start; until
      // then nothing is live, so nothing can be drawn.
      expect(reconnected.entries[0]).toMatchObject({ kind: 'state' });
      expect((reconnected.entries[0] as { state: { state: string } }).state.state).not.toBe('live');
      await until(() => reconnected.lastState()?.state === 'protected');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(reconnected.frames()).toEqual([]);
    },
    CASE_TIMEOUT,
  );

  it(
    'shows no protected-generation frame to any of several windows, and a stalled window slows none',
    async () => {
      rig = await openRig({ delayFramesMs: 250 });
      await rig.controller.navigate(url('motion.html'));
      const stalled = rig.openWindow();
      const a = rig.openWindow();
      const b = rig.openWindow();
      await moreFrames(a, 3);
      stalled.stall();
      await moreFrames(b, 5);
      expect(stalled.frames().length).toBeLessThan(b.frames().length);

      const latchedAt = Date.now();
      rig.controller.sensitiveScreenLatch.latch(rig.controller.topLevelDocumentEpoch());
      for (const window of [stalled, a, b]) await until(() => clearedIndex(window, latchedAt) >= 0);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      for (const window of [stalled, a, b]) {
        const cleared = window.entries[clearedIndex(window, latchedAt)] as { generation: number };
        for (const frame of framesAfter(window, clearedIndex(window, latchedAt))) {
          expect(frame.generation).toBeGreaterThan(cleared.generation);
        }
      }
      expect(rig.hub.capturing).toBe(false);
    },
    CASE_TIMEOUT,
  );

  it(
    'treats popup adoption as a target change and streams the adopted page',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('opener.html'));
      const window = rig.openWindow();
      await moreFrames(window, 1);
      const before = rig.hub.generation;
      const observation = await rig.controller.observe();
      const open = observation.interactables.find((entry) => entry.name === 'Open target');
      expect(open).toBeDefined();
      await rig.controller.click(open!.ref);
      const adopted = await rig.controller.adoptPopup();
      expect(adopted?.switched_to_new_tab).toContain('second.html');
      await moreFrames(window, 2);
      expect(rig.hub.generation).toBeGreaterThan(before);
      expect(window.frames().at(-1)!.generation).toBeGreaterThan(before);
      expect(window.lastState()).toMatchObject({ page: { title: 'Live view second fixture' } });
    },
    CASE_TIMEOUT,
  );

  it(
    'hides the screen while a protected field has focus, and shows it again on blur',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('login.html'));
      const window = rig.openWindow();
      await moreFrames(window, 2);
      const observation = await rig.controller.observe();
      const password = observation.interactables.find((entry) => entry.name === 'Password');
      expect(password).toBeDefined();
      const page = rig.controller.taskPageSource().current()!.page;
      const focusedAt = Date.now();
      await page.focus('#password');
      await until(() => clearedIndex(window, focusedAt) >= 0);
      expect(window.lastState()).toMatchObject({ state: 'protected' });
      const cleared = clearedIndex(window, focusedAt);
      await page.focus('#user');
      await until(() => window.lastState()?.state === 'live');
      await moreFrames(window, 2);
      const blurredGeneration = (window.entries[cleared] as { generation: number }).generation;
      expect(
        framesAfter(window, cleared).every((frame) => frame.generation > blurredGeneration),
      ).toBe(true);
    },
    CASE_TIMEOUT,
  );
});

function step(id: string, body: Record<string, unknown>): Step {
  return {
    id,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    ...body,
  } as Step;
}

describe('@no-llm live browser view: deterministic secret fill', () => {
  it(
    'protects a replay run from the secret latch until its next navigation',
    async () => {
      rig = await openRig();
      const runDir = mkdtempSync(join(tmpdir(), 'yantra-live-view-replay-'));
      const session = await new LocalBrowserProvider({
        profileStore: new LocalProfileStore(),
        logger: silent,
      }).launch({ profile: { kind: 'ephemeral' }, headless: true });
      try {
        const plan: Plan = {
          task_id: '01JEXAMPLETASKID0000000000',
          plan_id: '01JEXAMPLEPLANID0000000000',
          schema_version: SCHEMA_VERSION,
          default_scope: 'public',
          steps: [
            step('login', { type: 'navigate', url: { kind: 'literal', value: url('login.html') } }),
            step('ready', {
              type: 'wait_for',
              locator: { kind: 'workflow', name: 'Ready' },
              state: 'visible',
              timeout_ms: 10_000,
            }),
            step('secret', {
              type: 'fill',
              locator: { kind: 'workflow', name: 'Password' },
              value: { kind: 'secret', key: 'fixture.password' },
              submit: false,
            }),
            step('after', {
              type: 'wait_for',
              locator: { kind: 'workflow', name: 'After' },
              state: 'visible',
              timeout_ms: 10_000,
            }),
            step('next', { type: 'navigate', url: { kind: 'literal', value: url('second.html') } }),
            step('ready2', {
              type: 'wait_for',
              locator: { kind: 'workflow', name: 'Ready2' },
              state: 'visible',
              timeout_ms: 10_000,
            }),
          ],
          outputs: [],
        };
        const selectors: Record<string, string> = {
          Ready: '#ready',
          Password: '#password',
          After: '#after',
          Ready2: '#ready2',
        };
        const ctx = createExecutionContext({
          taskId: plan.task_id,
          plan,
          runDir,
          browser: session,
          ethics: { check: () => Promise.resolve() },
          logger: silent,
          secrets: { resolve: () => Promise.resolve('CANARY-live-view-secret') },
          workflowLocators: {
            resolve: (name) => ({
              name,
              strict: true,
              candidates: [
                {
                  source: 'authored',
                  intent: { kind: 'css', selector: selectors[name] ?? '#none' },
                },
              ],
            }),
          },
        });
        const commits: { epoch: number | null; at: number }[] = [];
        ctx.taskPage!.subscribe((event: TaskPageEvent) => {
          if (event.kind === 'navigation_committed')
            commits.push({ epoch: event.epoch, at: Date.now() });
        });
        let latchedAt = Number.POSITIVE_INFINITY;
        ctx.sensitiveScreenLatch!.subscribe((latched) => {
          if (latched) latchedAt = Date.now();
        });
        rig.attach(ctx.taskPage!);
        const window = rig.openWindow();

        const outcome = await new Executor().run(ctx);
        expect(outcome.status).toBe('completed');
        await until(
          () => window.lastState()?.state === 'live' && clearedIndex(window, latchedAt) >= 0,
          15_000,
          () => JSON.stringify(window.entries.filter((entry) => entry.kind !== 'frame')),
        );

        const cleared = clearedIndex(window, latchedAt);
        expect(cleared).toBeGreaterThan(0);
        // Frames before the secret fill, none between the latch and the next
        // navigation, and only post-navigation captures after it.
        expect(window.entries.slice(0, cleared).some((entry) => entry.kind === 'frame')).toBe(true);
        const secondCommit = commits.at(-1)!;
        for (const frame of framesAfter(window, cleared)) {
          expect(frame.capturedAt).toBeGreaterThanOrEqual(secondCommit.at - 50);
        }
        expect(ctx.sensitiveScreenLatch?.isLatched(ctx.settler?.epoch)).toBe(false);
        ctx.taskPage!.tearDown();
      } finally {
        await session.close();
        rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    CASE_TIMEOUT,
  );
});

describe('@no-llm live browser view: privacy and performance', () => {
  it(
    'writes no frame bytes and no page titles to host.log',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('motion.html'));
      const window = rig.openWindow();
      await moreFrames(window, 5);
      window.close();
      const log = readFileSync(rig.hostLogPath);
      expect(scanForFrames(join(rig.hostLogPath, '..'))).toEqual([]);
      expect(log.toString('utf8')).toContain('live view subscribed');
      expect(log.toString('utf8')).not.toContain('Live view motion fixture');
    },
    CASE_TIMEOUT,
  );

  it(
    'leaves no frame in a streamed run’s directory',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'yantra-live-view-runs-'));
      const previousHome = process.env.YANTRA_HOME;
      process.env.YANTRA_HOME = join(root, 'home');
      const hub = new LiveViewHub();
      let frames = 0;
      const client = hub.addClient({
        control: () => undefined,
        frame: (meta) => {
          frames += 1;
          client.ack({ generation: meta.generation, frame_seq: meta.frame_seq });
        },
      });
      client.start({ max_width: 640, max_height: 400 });
      try {
        const workflow = {
          version: 1,
          name: 'live-view-privacy',
          description: null,
          security_class: 'public',
          recorded_with: null,
          params: {},
          secrets: [],
          cookies: 'none',
          steps: [
            {
              id: 'one',
              verb: 'navigate',
              scope: null,
              requires_confirmation: false,
              confirmation_description: null,
              expected_cost: null,
              consequence: null,
              url: url('second.html'),
            },
            {
              id: 'wait',
              verb: 'wait_for',
              scope: null,
              requires_confirmation: false,
              confirmation_description: null,
              expected_cost: null,
              consequence: null,
              locator: 'Ready2',
              state: 'visible',
              timeout_ms: 10_000,
            },
          ],
          outputs: [],
          outputs_unredacted: false,
          _unrecorded_frames: [],
          _locators: { Ready2: [{ kind: 'css', value: '#ready2' }] },
        } as unknown as WorkflowFile;
        const orchestrator = new RunOrchestrator({
          workflowStore: { load: () => Promise.resolve(ok(workflow)) } as never,
          runStore: new LocalRunStore(join(root, 'runs')),
          browserProvider: new LocalBrowserProvider({
            profileStore: new LocalProfileStore(),
            logger: silent,
          }),
          keychain: {} as never,
          ethicsGate: { check: () => Promise.resolve() },
          logger: silent,
          liveView: hub,
        });
        const outcome = await orchestrator.run({
          workflowName: 'live-view-privacy',
          params: {},
          budgets: {},
          json: false,
          debug: false,
        });
        expect(outcome.kind).toBe('success');
        expect(frames).toBeGreaterThan(0);
        expect(scanForFrames(join(root, 'runs', outcome.runId))).toEqual([]);
      } finally {
        await hub.close();
        if (previousHome === undefined) delete process.env.YANTRA_HOME;
        else process.env.YANTRA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    CASE_TIMEOUT,
  );

  it(
    'delivers the motion page to a window at 5 fps or more',
    async () => {
      rig = await openRig();
      await rig.controller.navigate(url('motion.html'));
      const window = rig.openWindow();
      await moreFrames(window, 2);
      const start = window.frames().length;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const times = window
        .frames()
        .slice(start)
        .map((frame) => frame.at);
      expect(arrivalRate(times)).toBeGreaterThanOrEqual(5);
      // The S1 default caps it near 10 fps.
      expect(arrivalRate(times)).toBeLessThanOrEqual(12);
    },
    CASE_TIMEOUT,
  );
});
