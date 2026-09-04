import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ActionPhase,
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  EvidenceLedger,
  EvidencePhase,
  UrlPolicy,
  UrlProvenance,
  buildYantraWrappedTools,
  resolveVisionAvailability,
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    const sanitizer = new DefaultSanitizer();
    // Mirrors a real `--allow-host` run: the user named these hosts, so any
    // page on them is reachable while an assembled URL elsewhere is not.
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['127.0.0.1', 'localhost'] });
    const services: RunServices = {
      template: null,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      runDir,
      vision: resolveVisionAvailability({
        grantEnabled: false,
        hasBrowserTools: true,
        modelImageInput: false,
        suppressedByFlag: false,
        zeroLlm: true,
      }),
      budgets,
      sanitizer,
      urlPolicy: new UrlPolicy(budgets, { maxUrlLength: 2048, requireHttps: false }),
      urlProvenance: provenance,
      confirmation: { gateway: grantingGateway(), store: null },
      actionPhase: new ActionPhase(),
      evidence: new EvidenceLedger(sanitizer),
      evidencePhase: new EvidencePhase(),
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
          sensitiveScreenLatch: controller.sensitiveScreenLatch,
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

  it('fills a literal and host-bound secret, consumes the submit observation, and extracts a table capture', async () => {
    let observed = await observe();
    await call('browser_fill_element', {
      field: refByName(observed, 'Username'),
      value: { kind: 'literal', value: 'alice' },
    });
    observed = await observe();
    const secretFill = await call('browser_fill_element', {
      field: refByName(observed, 'Password'),
      value: { kind: 'secret_ref', key: 'site.password' },
    });
    expect(secretFill.status).toBe('ok');
    expect(JSON.stringify(secretFill)).not.toContain(SECRET_CANARY);
    observed = await observe();
    const submitted = await call('browser_click', { ref: refByName(observed, 'Submit form') });
    expect(submitted.status).toBe('ok');
    const submitPayload = JSON.parse(submitted.modelText) as {
      observation?: { digest?: string; interactables: { ref: string; name: string }[] };
    };
    expect(submitPayload.observation?.digest).toContain('Submitted');

    const extraction = await call('browser_extract', { kind: 'table' });
    const payload = JSON.parse(extraction.modelText) as { capture_ref: string; preview: unknown };
    expect(payload.capture_ref).toMatch(/^cap-/);
    expect(
      await readFile(join(runDir, 'captures', `${payload.capture_ref}.json`), 'utf8'),
    ).toContain('accepted');
  });

  it('surfaces disabled actionability and follows both popup mechanisms', async () => {
    await call('browser_navigate', { url: `${fixture.baseUrl}/form.html` });
    const form = await observe();
    const disabled = await call('browser_click', { ref: refByName(form, 'Disabled action') });
    expect(disabled.error_code).toBe('ELEMENT_DISABLED');

    // A tab the site opens on its own domain is where the click was going, so
    // the run continues in it and says so, rather than handing back an address.
    await call('browser_navigate', { url: `${fixture.baseUrl}/` });
    let observed = await observe();
    const target = await call('browser_click', { ref: refByName(observed, 'Target popup') });
    expect(target.modelText).toContain('switched_to_new_tab');
    expect(target.modelText).toContain('/popup.html');

    await call('browser_navigate', { url: `${fixture.baseUrl}/` });
    observed = await observe();
    const windowPopup = await call('browser_click', { ref: refByName(observed, 'Window popup') });
    expect(windowPopup.modelText).toContain('switched_to_new_tab');

    // A popup onto another site is still closed on sight and reported as an
    // address for the model to decide about explicitly.
    await call('browser_navigate', { url: `${fixture.baseUrl}/` });
    observed = await observe();
    const offsite = await call('browser_click', { ref: refByName(observed, 'Offsite popup') });
    expect(offsite.modelText).toContain('popup_intercepted');
    expect(offsite.modelText).not.toContain('switched_to_new_tab');
  });

  it('refuses a wrong-host secret before resolution and leaves no canary artifact', async () => {
    await call('browser_navigate', {
      url: `${fixture.baseUrl.replace('127.0.0.1', 'localhost')}/form.html`,
    });
    const observed = await observe();
    const mismatch = await call('browser_fill_element', {
      field: refByName(observed, 'Password'),
      value: { kind: 'secret_ref', key: 'site.password' },
    });
    expect(mismatch.error_code).toBe('SECRET_HOST_MISMATCH');

    const files = await listFiles(runDir);
    for (const file of files) {
      expect(await readFile(file, 'utf8')).not.toContain(SECRET_CANARY);
    }
  });

  it('reports a true delta through the wrapped tools, at one observation per action', async () => {
    // Real layout, real Chrome, through the tool seam the model actually uses.
    await call('browser_navigate', { url: `${fixture.baseUrl}/delta.html` });
    const observed = await observe();

    // A control set replaced by an identical one is not a change: every ref
    // trades hands, and a ref-keyed delta would report three of each. Done
    // first, while nothing is covering the page.
    const observations = vi.spyOn(controller, 'observe');
    const refreshed = await call('browser_click', {
      ref: refByName(observed, 'Refresh results'),
    });
    // Memory's rule, asserted at the outermost seam too: a whole wrapped action
    // takes exactly one post-action observation, and the delta rides it.
    expect(observations).toHaveBeenCalledTimes(1);
    observations.mockRestore();

    const refreshedModel = JSON.parse(refreshed.modelText) as {
      delta?: { elements_appeared?: unknown; elements_vanished?: unknown; incomplete?: string[] };
      observation?: unknown;
    };
    expect(refreshedModel.observation).toBeDefined();
    expect(refreshedModel.delta?.elements_appeared).toBeUndefined();
    expect(refreshedModel.delta?.elements_vanished).toBeUndefined();
    expect(refreshedModel.delta?.incomplete).toBeUndefined();

    // The cost evidence lands in the artifact projection, not in a new sink.
    const details = refreshed.details as { delta_bytes?: number; observation_bytes?: number };
    expect(details.delta_bytes).toBeGreaterThan(0);
    expect(details.observation_bytes).toBeGreaterThan(0);

    // A dialog opening is the most steering-relevant thing a delta can say.
    const beforeOpen = await observe();
    const opened = await call('browser_click', {
      ref: refByName(beforeOpen, 'Open preferences'),
    });
    const openedModel = JSON.parse(opened.modelText) as {
      delta?: { dialogs_opened?: { role: string; name: string }[] };
    };
    expect(openedModel.delta?.dialogs_opened).toEqual([{ role: 'dialog', name: 'Cookie consent' }]);

    // And closing it is reported the same way, by the same signal.
    const afterOpen = await observe();
    const closed = await call('browser_click', { ref: refByName(afterOpen, 'Close') });
    const closedModel = JSON.parse(closed.modelText) as {
      delta?: { dialogs_closed?: { role: string; name: string }[] };
    };
    expect(closedModel.delta?.dialogs_closed).toEqual([{ role: 'dialog', name: 'Cookie consent' }]);
  }, 90_000);

  it('says a new document is a new document rather than counting its controls', async () => {
    await call('browser_navigate', { url: `${fixture.baseUrl}/delta.html` });
    await observe();
    const navigated = await call('browser_navigate', { url: `${fixture.baseUrl}/form.html` });

    const model = JSON.parse(navigated.modelText) as {
      delta?: {
        url_changed?: { from: string; to: string };
        incomplete?: string[];
        complete?: false;
        elements_appeared?: unknown;
        elements_vanished?: unknown;
      };
    };
    expect(model.delta?.url_changed).toEqual({
      from: `${fixture.baseUrl}/delta.html`,
      to: `${fixture.baseUrl}/form.html`,
    });
    expect(model.delta?.complete).toBe(false);
    expect(model.delta?.incomplete).toEqual(['document-replaced']);
    expect(model.delta?.elements_appeared).toBeUndefined();
    expect(model.delta?.elements_vanished).toBeUndefined();
  }, 60_000);

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
