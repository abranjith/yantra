/**
 * @no-llm agent real-browser widget gauntlet.
 *
 * Deliberately ungated: like the established agent-browser suite, only Chrome
 * discovery is environment-dependent. A test suite skipped by CI cannot be the
 * interaction gate. The stable tool-calls.jsonl projection remains owned by
 * packages/agent/tests/runtime/run-recorder.spec.ts; this harness has no run
 * orchestrator and does not re-derive that projection.
 */

import { mkdtemp, rm } from 'node:fs/promises';
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
  type RunServices,
  type WrappedTool,
} from '@yantra/agent';
import {
  AgentBrowserController,
  DefaultSanitizer,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  ScriptRegistry,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROTOCOL_GAUNTLET } from '../packages/core/tests/support/gauntlet.js';

import { serveFixtureSite, type FixtureServer } from './fixtures/serve.js';
import {
  AGENT_GAUNTLET,
  agentFixtureFiles,
  countingController,
  type AgentClickFixture,
  type AgentFillFixture,
} from './gauntlet/registry.js';

describe('@no-llm agent real-browser widget gauntlet', () => {
  let fixture: FixtureServer;
  let runDir: string;
  let baseController: AgentBrowserController;
  let counted: ReturnType<typeof countingController>;
  let tools: WrappedTool[];

  beforeAll(async () => {
    fixture = await serveFixtureSite();
    runDir = await mkdtemp(join(tmpdir(), 'yantra-widget-gauntlet-'));
    baseController = new AgentBrowserController({
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      browserProvider: new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
      maxDigestBytes: 8 * 1024,
    });
    counted = countingController(baseController);
    tools = buildYantraWrappedTools(buildServices(runDir, counted.controller));
  }, 30_000);

  afterAll(async () => {
    await baseController?.teardown();
    await fixture?.close();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  const fills = AGENT_GAUNTLET.filter(
    (entry): entry is AgentFillFixture => entry.exercise === 'fill',
  );
  const clicks = AGENT_GAUNTLET.filter(
    (entry): entry is AgentClickFixture => entry.exercise === 'click',
  );

  it.each(fills)(
    '$pattern',
    async (descriptor) => {
      await call('browser_navigate', { url: `${fixture.baseUrl}/gauntlet/${descriptor.file}` });
      const observed = parseObservation(await call('browser_observe', {}));
      const field = observed.interactables.find(
        (entry) => entry.role === descriptor.field.role && entry.name === descriptor.field.name,
      );
      if (!field) throw new Error(`missing ${descriptor.field.role} ${descriptor.field.name}`);
      const preRemountRef = field.ref;
      counted.reset();

      let topLevelToolCalls = 0;
      topLevelToolCalls += 1;
      const result = await call('browser_fill_element', {
        field: preRemountRef,
        value: { kind: 'literal', value: descriptor.value },
      });
      const payload = JSON.parse(result.modelText) as {
        committed?: string;
        observation?: { interactables: readonly { ref: string }[] };
      };
      expect(result.status).toBe('ok');
      expect(result.error_code).toBeUndefined();
      expect(payload.committed).toBe(descriptor.expectedCommitted);
      expect(topLevelToolCalls).toBe(descriptor.expectedToolCalls);
      expect(counted.counts.mutations).toBe(descriptor.expectedMutations);
      expect(counted.counts.reads).toBe(descriptor.expectedReads);
      for (const entry of payload.observation?.interactables ?? []) {
        expect(() => counted.controller.resolveRef(entry.ref)).not.toThrow();
      }
      if (!descriptor.remountSelector) return;
      const postActionRef = payload.observation?.interactables.find(
        (entry) => entry.ref === preRemountRef,
      )?.ref;
      if (!postActionRef) throw new Error('missing post-action field ref');
      await counted.controller.evaluate(() => {
        const pageGlobal = globalThis as unknown as {
          document: {
            querySelector(selector: string): {
              cloneNode(deep: boolean): unknown;
              replaceWith(node: unknown): void;
            } | null;
          };
        };
        const input = pageGlobal.document.querySelector('#query');
        if (!input) throw new Error('missing remount target');
        input.replaceWith(input.cloneNode(false));
      });
      await expect(
        counted.controller.click(postActionRef, { healStale: false }),
      ).rejects.toMatchObject({
        code: 'STALE_ELEMENT_REF',
      });
    },
    30_000,
  );

  it.each(clicks)(
    '$pattern',
    async (descriptor) => {
      await call('browser_navigate', { url: `${fixture.baseUrl}/gauntlet/${descriptor.file}` });
      const observed = parseObservation(await call('browser_observe', {}));
      const control = observed.interactables.find(
        (entry) => entry.role === descriptor.control.role && entry.name === descriptor.control.name,
      );
      if (!control) {
        throw new Error(`missing ${descriptor.control.role} ${descriptor.control.name}`);
      }
      counted.reset();

      let topLevelToolCalls = 0;
      topLevelToolCalls += 1;
      const result = await call('browser_click', { ref: control.ref });
      const payload = JSON.parse(result.modelText) as {
        attempted?: readonly { readonly strategy: string }[];
        message?: string;
      };
      const clearances = (payload.attempted ?? []).filter(
        (entry) => entry.strategy === 'clear-obstruction',
      ).length;
      const details = result.details as {
        readonly kind?: string;
        readonly candidates?: readonly unknown[];
        readonly clearance_skipped?: string;
      } | null;
      expect(topLevelToolCalls).toBe(descriptor.expectedToolCalls);
      expect(counted.counts.mutations).toBe(descriptor.expectedMutations);
      expect(counted.counts.reads).toBe(descriptor.expectedReads);
      expect(clearances).toBe(descriptor.expectedClearances);

      if (descriptor.expected.kind === 'commit') {
        expect(result.status).toBe('ok');
        expect(result.error_code).toBeUndefined();
        // The control was actually activated — the page says so, not the tool.
        const verify = descriptor.expected.verify;
        const text = await counted.controller.evaluate(
          (selector: string) =>
            (
              globalThis as unknown as {
                document: { querySelector(css: string): { textContent: string | null } | null };
              }
            ).document.querySelector(selector)?.textContent ?? '',
          verify.selector,
        );
        expect(text.trim()).toBe(verify.text);
        return;
      }

      // An engineered refusal, not a frozen unknown failure: the code, the
      // structural kind, and the absence of anything to press are all declared.
      expect(result.status).toBe('error');
      expect(result.error_code).toBe(descriptor.expected.errorCode);
      expect(details?.kind).toBe(descriptor.expected.obstructionKind);
      expect(details?.candidates).toHaveLength(descriptor.expected.candidates);
      expect(details?.clearance_skipped).toBe(descriptor.expected.clearanceSkipped);
      expect(payload.message ?? '').toMatch(/browser_observe/);

      // Follow-up: obey the failure's own hint. Once the pinned band no longer
      // owns the coordinate, the same ref is reachable and the re-issued call
      // succeeds — the refusal was about reachability, not about the control.
      await counted.controller.evaluate(() => {
        (
          globalThis as unknown as {
            document: { querySelector(css: string): { remove(): void } | null };
          }
        ).document
          .querySelector('#band')
          ?.remove();
      });
      const followUp = await call('browser_click', { ref: control.ref });
      expect(followUp.status).toBe('ok');
    },
    30_000,
  );

  it('has exactly one descriptor for every agent-tier fixture', () => {
    // Set equality in both directions: an unregistered fixture and a descriptor
    // naming a file that does not exist are both failures.
    expect(agentFixtureFiles()).toEqual(AGENT_GAUNTLET.map((entry) => entry.file).sort());
    expect(AGENT_GAUNTLET).toHaveLength(agentFixtureFiles().length);
  });

  it('reaches the open-shadow control by name and leaves the closed one unreachable', async () => {
    await call('browser_navigate', { url: `${fixture.baseUrl}/gauntlet/open-shadow-select.html` });
    const observed = parseObservation(await call('browser_observe', {}));

    // Addressed by its accessible name, not by a ref the test looked up: the
    // point is that the control is *nameable*, which it was not before.
    const result = await call('browser_fill_element', {
      field: 'Delivery speed',
      value: { kind: 'literal', value: 'Overnight' },
    });
    expect(result.status).toBe('ok');
    expect((JSON.parse(result.modelText) as { committed?: string }).committed).toBe('Overnight');

    // The page itself confirms the commit landed inside the shadow tree.
    const status = await counted.controller.evaluate(
      () =>
        (
          globalThis as unknown as {
            document: { querySelector(css: string): { textContent: string | null } | null };
          }
        ).document.querySelector('#status')?.textContent ?? '',
    );
    expect(status).toBe('open:Overnight');

    // A closed root is withheld by the platform, so its control is absent from
    // observation rather than filtered out of it. Not a third expected-outcome
    // arm: "we cannot do this yet" is unrepresentable on purpose, and a closed
    // root is not a gauntlet pass.
    const payload = JSON.stringify(observed.interactables);
    expect(payload).not.toContain('Billing cycle');
    expect(observed.interactables.map((entry) => entry.name)).toContain('Delivery speed');

    // The traversal's internal fields never reach the model. Asserted on the
    // key names, because the values are ordinary strings that could occur in
    // page text; the keys could only come from the projection.
    for (const internal of ['composedScope', 'elementIndex', 'rootNodeDepth', 'selectorIndex']) {
      expect(payload).not.toContain(internal);
      expect(result.modelText).not.toContain(internal);
    }
    // Each entry carries exactly the model-visible projection and nothing else.
    for (const entry of observed.interactables) {
      expect(Object.keys(entry).every((key) => !key.startsWith('composed'))).toBe(true);
    }
    // The structural token `open-shadow` is a controller-log literal only. It
    // is not a discriminator either way: nothing here may key off a host.
    expect(JSON.stringify(result.details ?? {})).not.toContain('127.0.0.1');

    for (const entry of observed.interactables) {
      expect(() => counted.controller.resolveRef(entry.ref)).not.toThrow();
    }
  }, 30_000);

  it('completes the seventeen-fixture gallery across both tiers', () => {
    // The gate FEAT-034 waits on, stated as a number so growing the gallery is
    // a deliberate edit rather than a side effect.
    expect(AGENT_GAUNTLET).toHaveLength(4);
    expect(PROTOCOL_GAUNTLET.length + AGENT_GAUNTLET.length).toBe(17);
  });

  it('encodes a distinct generic pattern per fixture', () => {
    const patterns = AGENT_GAUNTLET.map((entry) => entry.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  async function call(name: string, params: unknown) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.execute(params, undefined);
  }
});

function parseObservation(result: { readonly status: string; readonly modelText: string }): {
  readonly interactables: readonly {
    readonly ref: string;
    readonly role: string;
    readonly name: string;
  }[];
} {
  expect(result.status).toBe('ok');
  return JSON.parse(result.modelText) as {
    readonly interactables: readonly {
      readonly ref: string;
      readonly role: string;
      readonly name: string;
    }[];
  };
}

function buildServices(runDir: string, controller: AgentBrowserController): RunServices {
  const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, maxBytesPerResult: 12 * 1024 });
  const sanitizer = new DefaultSanitizer();
  const provenance = new UrlProvenance();
  provenance.seed({ allowedHosts: ['127.0.0.1', 'localhost'] });
  const ethics = { check: () => Promise.resolve() };
  let interactionClockMs = 0;
  return {
    template: null,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir,
    budgets,
    sanitizer,
    urlPolicy: new UrlPolicy(budgets, { maxUrlLength: 2048, requireHttps: false }),
    urlProvenance: provenance,
    confirmation: {
      gateway: {
        request: (request) =>
          Promise.resolve({
            confirmation_id: request.confirmation_id,
            decision: 'granted' as const,
            decided_at: new Date().toISOString(),
            decided_by: 'user_interactive' as const,
          }),
      },
      store: null,
    },
    actionPhase: new ActionPhase(),
    evidence: new EvidenceLedger(sanitizer),
    evidencePhase: new EvidencePhase(),
    trace: null,
    abortSignal: new AbortController().signal,
    // The fill engine's stability bounds use this injected clock. Advancing it
    // in fixed steps makes the exact controller-read budget independent of CI
    // scheduler jitter while all browser operations still execute in Chrome.
    now: () => {
      interactionClockMs += 1_000;
      return interactionClockMs;
    },
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
        secretResolver: null,
        secretHosts: () => Promise.resolve([]),
        captureThresholdBytes: 1024,
      },
      rank: null,
    },
  };
}
