import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ActionPhase,
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  UrlPolicy,
  buildYantraWrappedTools,
  type RunServices,
  type WrappedTool,
} from '@yantra/agent';
import {
  AgentBrowserController,
  DefaultOpaqueRefResolver,
  DefaultSanitizer,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  ScriptRegistry,
  type ConfirmationGateway,
  type ConfirmationOutcome,
} from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveFixtureSite, type FixtureServer } from './fixtures/serve.js';

const SECRET_CANARY = 'YANTRA-browser-secret-canary';

describe('@no-llm real Chrome browser tools', () => {
  let fixture: FixtureServer;
  let runDir: string;
  let controller: AgentBrowserController;
  let tools: WrappedTool[];

  beforeAll(async () => {
    fixture = await serveFixtureSite();
    runDir = await mkdtemp(join(tmpdir(), 'yantra-agent-browser-e2e-'));
    controller = new AgentBrowserController({
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      browserProvider: new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
      maxDigestBytes: 8 * 1024,
    });
    const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxBytesPerResult: 12 * 1024 });
    const ethics = { check: () => Promise.resolve() };
    const resolver = new DefaultOpaqueRefResolver({
      keychain: {
        get: () => Promise.resolve(SECRET_CANARY),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(true),
        list: () => Promise.resolve([]),
        isAvailable: () => Promise.resolve(true),
      },
    });
    const services: RunServices = {
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      runDir,
      budgets,
      sanitizer: new DefaultSanitizer(),
      urlPolicy: new UrlPolicy(budgets, { maxUrlLength: 2048, requireHttps: false }),
      confirmation: { gateway: grantingGateway(), store: null },
      actionPhase: new ActionPhase(),
      trace: null,
      abortSignal: new AbortController().signal,
      now: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      domain: {
        search: {
          resolveProvider: () => Promise.resolve({ isOk: false, error: { message: 'unused' } }),
          resultCap: 5,
          fetchTop: 3,
        },
        fetch: {
          fetcher: { fetch: () => Promise.reject(new Error('unused')) },
          extractor: new ReadabilityExtractor(),
          ethics,
          allowedContentTypes: ['text/html'],
          maxContentBytes: 1024,
          captureThresholdBytes: 1024,
        },
        script: { registry: new ScriptRegistry() },
        publish: { publish: () => Promise.reject(new Error('unused')) },
        workflow: null,
        browser: {
          controller,
          ethics,
          secretResolver: resolver,
          secretHosts: () => Promise.resolve(['127.0.0.1']),
          captureThresholdBytes: 1,
        },
        rank: null,
      },
    };
    tools = buildYantraWrappedTools(services);
  }, 30_000);

  afterAll(async () => {
    await controller?.teardown();
    await fixture?.close();
    await rm(runDir, { recursive: true, force: true });
  });

  it('navigates, observes, clicks, and rejects the stale pre-navigation ref', async () => {
    await call('browser_navigate', { url: `${fixture.baseUrl}/` });
    const observed = await observe();
    const form = refByName(observed, 'Open form');
    const clicked = await call('browser_click', { ref: form });
    expect(clicked.status).toBe('ok');
    expect(clicked.modelText).toContain('form.html');
    const stale = await call('browser_click', { ref: form });
    expect(stale.error_code).toBe('STALE_ELEMENT_REF');
  });

  it('fills a literal and host-bound secret, submits, observes, and extracts a table capture', async () => {
    let observed = await observe();
    await call('browser_fill', {
      ref: refByName(observed, 'Username'),
      value: { kind: 'literal', value: 'alice' },
    });
    observed = await observe();
    const secretFill = await call('browser_fill', {
      ref: refByName(observed, 'Password'),
      value: { kind: 'secret_ref', key: 'site.password' },
    });
    expect(secretFill.status).toBe('ok');
    expect(JSON.stringify(secretFill)).not.toContain(SECRET_CANARY);
    observed = await observe();
    const submitted = await call('browser_click', { ref: refByName(observed, 'Submit form') });
    expect(submitted.status).toBe('ok');
    observed = await observe();
    expect(observed.digest).toContain('Submitted');

    const extraction = await call('browser_extract', { kind: 'table' });
    const payload = JSON.parse(extraction.modelText) as { capture_ref: string; preview: unknown };
    expect(payload.capture_ref).toMatch(/^cap-/);
    expect(
      await readFile(join(runDir, 'captures', `${payload.capture_ref}.json`), 'utf8'),
    ).toContain('accepted');
  });

  it('surfaces disabled actionability and intercepts both popup mechanisms', async () => {
    await call('browser_navigate', { url: `${fixture.baseUrl}/form.html` });
    const form = await observe();
    const disabled = await call('browser_click', { ref: refByName(form, 'Disabled action') });
    expect(disabled.error_code).toBe('ELEMENT_DISABLED');

    await call('browser_navigate', { url: `${fixture.baseUrl}/` });
    let observed = await observe();
    const target = await call('browser_click', { ref: refByName(observed, 'Target popup') });
    expect(target.modelText).toContain('popup_intercepted');
    observed = await observe();
    const windowPopup = await call('browser_click', { ref: refByName(observed, 'Window popup') });
    expect(windowPopup.modelText).toContain('popup_intercepted');
  });

  it('refuses a wrong-host secret before resolution and leaves no canary artifact', async () => {
    const localhostUrl = fixture.baseUrl.replace('127.0.0.1', 'localhost');
    await call('browser_navigate', { url: `${localhostUrl}/form.html` });
    const observed = await observe();
    const mismatch = await call('browser_fill', {
      ref: refByName(observed, 'Password'),
      value: { kind: 'secret_ref', key: 'site.password' },
    });
    expect(mismatch.error_code).toBe('SECRET_HOST_MISMATCH');

    const files = await listFiles(runDir);
    for (const file of files) {
      expect(await readFile(file, 'utf8')).not.toContain(SECRET_CANARY);
    }
  });

  it('starts and stops the fixture harness cleanly', async () => {
    const extra = await serveFixtureSite();
    await expect(fetch(`${extra.baseUrl}/`).then((response) => response.status)).resolves.toBe(200);
    await extra.close();
  });

  async function call(name: string, params: unknown) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute(params, undefined);
  }

  async function observe(): Promise<{
    interactables: { ref: string; name: string }[];
    digest: string;
  }> {
    const result = await call('browser_observe', {});
    expect(result.status).toBe('ok');
    return JSON.parse(result.modelText) as {
      interactables: { ref: string; name: string }[];
      digest: string;
    };
  }
});

function refByName(
  observation: { interactables: { ref: string; name: string }[] },
  name: string,
): string {
  const found = observation.interactables.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing observed ref for ${name}`);
  return found.ref;
}

function grantingGateway(): ConfirmationGateway {
  return {
    request: (request: ConfirmationRequest): Promise<ConfirmationOutcome> =>
      Promise.resolve({
        confirmation_id: request.confirmation_id,
        decision: 'granted',
        decided_at: new Date().toISOString(),
        decided_by: 'user_interactive',
      }),
  };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}
