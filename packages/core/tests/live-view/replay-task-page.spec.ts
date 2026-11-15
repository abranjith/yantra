// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION, type Plan, type Step } from '@yantra/protocol';
import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PageSettler } from '../../src/browser/page-settle.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import { ScreenProtection } from '../../src/browser/screen-protection.js';
import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';
import type { BrowserSession, Logger } from '../../src/browser/types.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import { Executor } from '../../src/executor/executor.js';
import { ReplayTaskPage } from '../../src/live-view/replay-task-page.js';
import type { TaskPageEvent } from '../../src/live-view/task-page-source.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

/** A settler double: an epoch and the second-listener hook, nothing else. */
function fakeSettler(): PageSettler & { commit(): void } {
  let epoch = 0;
  const listeners = new Set<() => void>();
  return {
    get epoch() {
      return epoch;
    },
    addNavigationListener(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit() {
      epoch += 1;
      for (const listener of listeners) listener();
    },
  } as unknown as PageSettler & { commit(): void };
}

function tracker(onListenerError = vi.fn()) {
  const taskPage = new ReplayTaskPage(new ScreenProtection(new SensitiveScreenLatch()), {
    headless: true,
    onListenerError,
  });
  const events: TaskPageEvent[] = [];
  taskPage.subscribe((event) => events.push(event));
  return { taskPage, events, onListenerError };
}

const pageA = { id: 'a' } as unknown as PuppeteerPage;
const pageB = { id: 'b' } as unknown as PuppeteerPage;

describe('@no-llm ReplayTaskPage', () => {
  it('has no page until one is attached', () => {
    const { taskPage } = tracker();
    expect(taskPage.current()).toBeNull();
    expect(taskPage.topLevelEpoch()).toBeNull();
  });

  it('announces the first page, then each commit with its epoch', () => {
    const { taskPage, events } = tracker();
    const settler = fakeSettler();
    taskPage.attach(pageA, settler);
    settler.commit();
    settler.commit();
    expect(events).toEqual([
      { kind: 'page_installed' },
      { kind: 'navigation_committed', epoch: 1 },
      { kind: 'navigation_committed', epoch: 2 },
    ]);
    expect(taskPage.current()).toEqual({ page: pageA, headless: true });
    expect(taskPage.topLevelEpoch()).toBe(2);
  });

  it('binds a settler that arrives after the page without a second install event', () => {
    const { taskPage, events } = tracker();
    taskPage.attach(pageA, null);
    const settler = fakeSettler();
    taskPage.attach(pageA, settler);
    taskPage.attach(pageA, settler);
    settler.commit();
    expect(events.map((event) => event.kind)).toEqual(['page_installed', 'navigation_committed']);
  });

  it('treats a different page (a resumed run) as a target change and stops hearing the old settler', () => {
    const { taskPage, events } = tracker();
    const oldSettler = fakeSettler();
    taskPage.attach(pageA, oldSettler);
    taskPage.attach(pageB, fakeSettler());
    oldSettler.commit();
    expect(events.map((event) => event.kind)).toEqual(['page_installed', 'target_changed']);
    expect(taskPage.current()?.page).toBe(pageB);
  });

  it('tears down once and forgets the page', () => {
    const { taskPage, events } = tracker();
    const settler = fakeSettler();
    taskPage.attach(pageA, settler);
    taskPage.tearDown();
    taskPage.tearDown();
    settler.commit();
    expect(events.map((event) => event.kind)).toEqual(['page_installed', 'torn_down']);
    expect(taskPage.current()).toBeNull();
  });

  it('reports a throwing listener and keeps notifying the others', () => {
    const { taskPage, events, onListenerError } = tracker();
    taskPage.subscribe(() => {
      throw new Error('listener bug');
    });
    taskPage.attach(pageA, null);
    expect(events).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'listener bug' }),
    );
  });
});

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function navigate(id: string, url: string): Step {
  return {
    id,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    type: 'navigate',
    url: { kind: 'literal', value: url },
  } as Step;
}

describe('@no-llm replay task page on a fixture workflow (real Chrome)', () => {
  let fixture: MigrationBrowserFixture;
  let session: BrowserSession;
  let server: Server;
  let baseUrl: string;
  const runDirs: string[] = [];

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><p>fixture</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fixture = await beginMigrationBrowserFixture();
    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silent,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true, ...fixture.launchOptions });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
    await new Promise((resolve) => server?.close(resolve));
    await Promise.all(runDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('emits page_installed, then a commit per navigate step with increasing epochs', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-replay-task-page-'));
    runDirs.push(runDir);
    const plan: Plan = {
      task_id: '01JEXAMPLETASKID0000000000',
      plan_id: '01JEXAMPLEPLANID0000000000',
      schema_version: SCHEMA_VERSION,
      default_scope: 'public',
      steps: [navigate('one', `${baseUrl}/one`), navigate('two', `${baseUrl}/two`)],
      outputs: [],
    };
    const ctx = createExecutionContext({
      taskId: plan.task_id,
      plan,
      runDir,
      browser: session,
      ethics: { check: () => Promise.resolve() },
      logger: silent,
    });
    const events: TaskPageEvent[] = [];
    ctx.taskPage!.subscribe((event) => events.push(event));
    expect(ctx.taskPage!.screenProtection).toBe(ctx.screenProtection);

    const outcome = await new Executor().run(ctx);
    expect(outcome.status).toBe('completed');
    expect(events[0]).toEqual({ kind: 'page_installed' });
    const epochs = events
      .filter((event) => event.kind === 'navigation_committed')
      .map((event) => (event.kind === 'navigation_committed' ? event.epoch : null));
    expect(epochs.length).toBeGreaterThanOrEqual(2);
    expect(epochs).toEqual([...epochs].sort((a, b) => a! - b!));
    expect(ctx.taskPage!.topLevelEpoch()).toBe(ctx.settler!.epoch);
    expect(ctx.taskPage!.current()?.page).toBe(ctx.page!.puppeteerPage);
    ctx.taskPage!.tearDown();
    expect(events[events.length - 1]).toEqual({ kind: 'torn_down' });
  }, 45_000);
});
