// @no-llm
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FillElementStep, FillStep, Plan, Step } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import { handleFillElement } from '../../src/executor/step-handlers/fill-element.js';
import { handleFill } from '../../src/executor/step-handlers/fill.js';
import type { ExecutionContext, StepResult } from '../../src/executor/types.js';
import type { EngineLocatorChain } from '../../src/locator/types.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface ObservedEvent {
  readonly type: string;
  readonly detail: number;
}

const runMigrationBrowser =
  Boolean(process.env.YANTRA_TEST_BROWSER_PATH) ||
  process.env.YANTRA_MIGRATION_SUITE_REQUIRED === '1';

describe.runIf(runMigrationBrowser)('@no-llm Puppeteer input migration characterization', () => {
  let fixture: MigrationBrowserFixture;
  let session: BrowserSession;
  let page: Page;
  const runDirs: string[] = [];

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true, ...fixture.launchOptions });
    page = await session.newPage();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
    await Promise.all(runDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  for (const sample of [
    { label: 'text input', markup: '<input id="field" aria-label="Field" value="old">' },
    {
      label: 'multiline textarea',
      markup: '<textarea id="field" aria-label="Field">old</textarea>',
    },
    {
      label: 'contenteditable',
      markup: '<div id="field" role="textbox" aria-label="Field" contenteditable="true">old</div>',
    },
  ]) {
    it(`replaces a pre-populated ${sample.label} through the legacy fill handler`, async () => {
      await installFixture(sample.markup);
      const step = legacyFill({ kind: 'literal', value: 'new text' });
      const { result, context } = await runStep(step, handleFill);

      expect(result).toEqual({ kind: 'completed' });
      expect(await fieldValue()).toBe('new text');
      await expectCharacterizedEvents('new text', 8);
      expect(JSON.stringify({ result, captures: context.captures.snapshot() })).not.toContain(
        'new text',
      );
    });
  }

  it('replaces a pre-populated password through the resolved-secret boundary', async () => {
    const canary = 'CANARY-migration-secret';
    await installFixture('<input id="field" type="password" aria-label="Field" value="old">');
    const step = legacyFill({ kind: 'secret', key: 'fixture.password' });
    const { result, context } = await runStep(step, handleFill, {
      resolve: async () => canary,
    });

    expect(result).toEqual({ kind: 'completed' });
    expect(await fieldValue()).toBe(canary);
    await expectCharacterizedEvents(canary, 8);
    expect(JSON.stringify({ result, captures: context.captures.snapshot() })).not.toContain(canary);
  });

  it('preserves replacement and secret masking through semantic fill_element replay', async () => {
    const canary = 'CANARY-semantic-secret';
    await installFixture('<input id="field" type="password" aria-label="Password" value="old">');
    const step = semanticFill({ kind: 'secret', key: 'fixture.password' });
    const { result, context } = await runStep(step, handleFillElement, {
      resolve: async () => canary,
    });

    expect(result).toMatchObject({ kind: 'completed' });
    expect(await fieldValue()).toBe(canary);
    await expectCharacterizedEvents(canary, 8);
    expect(JSON.stringify({ result, captures: context.captures.snapshot() })).not.toContain(canary);
  });

  it('keeps the saved replay result artifact byte-stable across the driver pin', async () => {
    await installFixture('<input id="field" aria-label="Field" value="old">');
    const { result } = await runStep(legacyFill({ kind: 'literal', value: 'stable' }), handleFill);
    const artifact = `${JSON.stringify({ schema_version: SCHEMA_VERSION, result })}\n`;
    const baseline = await readFile(
      join(coreRoot, 'tests', 'fixtures', 'puppeteer-migration-replay-baseline.json'),
      'utf8',
    );
    expect(artifact).toBe(baseline);
  });

  async function installFixture(markup: string): Promise<void> {
    await page.puppeteerPage!
      .setContent(`<!doctype html><title>Input fixture</title>${markup}<script>
      window.__events = [];
      const field = document.getElementById('field');
      for (const type of ['click', 'dblclick', 'input', 'change']) {
        field.addEventListener(type, event => window.__events.push({ type, detail: event.detail || 0 }));
      }
    </script>`);
  }

  async function fieldValue(): Promise<string> {
    return page.puppeteerPage!.$eval('#field', (element) =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? ''),
    );
  }

  async function observedEvents(): Promise<readonly ObservedEvent[]> {
    return page.puppeteerPage!.evaluate(
      () =>
        (window as typeof window & { __events?: ObservedEvent[] }).__events?.map((event) => ({
          type: event.type,
          detail: event.detail,
        })) ?? [],
    );
  }

  async function expectCharacterizedEvents(
    _text: string,
    expectedInputCount: number,
  ): Promise<void> {
    const events = await observedEvents();
    const packageJson = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8')) as {
      dependencies: { 'puppeteer-core': string };
    };
    const driverMajor = Number(packageJson.dependencies['puppeteer-core'].match(/\d+/)?.[0]);
    const pointerEvents = events.filter(
      (event) => event.type === 'click' || event.type === 'dblclick',
    );
    expect(pointerEvents).toEqual(driverMajor >= 25 ? [] : [{ type: 'click', detail: 3 }]);
    expect(events.filter((event) => event.type === 'input')).toHaveLength(expectedInputCount);
    expect(events.filter((event) => event.type === 'change')).toHaveLength(0);
  }

  async function runStep<TStep extends Step>(
    step: TStep,
    handler: (step: TStep, context: ExecutionContext) => Promise<StepResult>,
    secrets: ExecutionContext['secrets'] = null,
  ): Promise<{ readonly result: StepResult; readonly context: ExecutionContext }> {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-input-characterization-'));
    runDirs.push(runDir);
    const plan: Plan = {
      task_id: '01JEXAMPLETASKID0000000000',
      plan_id: '01JEXAMPLEPLANID0000000000',
      schema_version: SCHEMA_VERSION,
      default_scope: 'public',
      steps: [step],
      outputs: [],
    };
    const context = createExecutionContext({
      taskId: plan.task_id,
      plan,
      runDir,
      browser: session,
      page,
      ethics: { check: () => Promise.resolve() },
      logger,
      secrets,
      workflowLocators: {
        resolve: (): EngineLocatorChain => ({
          name: 'Field',
          strict: true,
          candidates: [{ source: 'authored', intent: { kind: 'css', selector: '#field' } }],
        }),
      },
    });
    return { result: await handler(step, context), context };
  }
});

function legacyFill(value: FillStep['value']): FillStep {
  return {
    id: 'fill',
    type: 'fill',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    locator: { kind: 'workflow', name: 'Field' },
    value,
    submit: false,
  };
}

function semanticFill(value: FillElementStep['value']): FillElementStep {
  return {
    id: 'fill-element',
    type: 'fill_element',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    field_name: 'Password',
    locator: { kind: 'workflow', name: 'Field' },
    value,
  };
}
