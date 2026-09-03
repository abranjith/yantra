/** @no-llm interaction message inventory for tool and middleware surfaces. */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DefaultSanitizer,
  INTERACTION_MESSAGES,
  ReadabilityExtractor,
  ScriptRegistry,
} from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { buildYantraWrappedTools, yantraToolCatalog } from '../../src/adapters/pi/tools/index.js';
import { BudgetTracker, DEFAULT_BUDGET_LIMITS } from '../../src/runtime/budget.js';
import { AGENT_INTERACTION_MESSAGES, renderAgentMessage } from '../../src/runtime/messages.js';
import {
  ActionPhase,
  EvidenceLedger,
  EvidencePhase,
  type RunServices,
} from '../../src/runtime/run-services.js';
import { UrlPolicy } from '../../src/runtime/url-policy.js';
import { UrlProvenance } from '../../src/runtime/url-provenance.js';

describe('@no-llm agent interaction message catalog', () => {
  it('renders every template, requires declared details, and is globally distinct', () => {
    for (const template of AGENT_INTERACTION_MESSAGES) {
      const details = detailsFor(template.code, template.requiredDetails);
      expect(() =>
        renderAgentMessage(
          template.surface as 'tool' | 'middleware',
          template.code,
          template.cause,
          details,
        ),
      ).not.toThrow();
      if (template.requiredDetails.length > 0) {
        expect(() =>
          renderAgentMessage(
            template.surface as 'tool' | 'middleware',
            template.code,
            template.cause,
            {},
          ),
        ).toThrow();
      }
    }

    const all = [...INTERACTION_MESSAGES, ...AGENT_INTERACTION_MESSAGES];
    const rendered = all.map((template) =>
      template.message(detailsFor(template.code, template.requiredDetails)),
    );
    expect(
      new Set(
        all.map((template) => `${template.surface}\u0000${template.code}\u0000${template.cause}`),
      ).size,
    ).toBe(all.length);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('resolves every tool capability against the active wrapped-tool catalog', () => {
    const services = buildServices();
    const active = new Set(yantraToolCatalog(services).map((entry) => entry.name));
    // Core-owned templates are included deliberately: FEAT-033's obstruction
    // entries live in core but declare `capabilityKind: 'tool'`, and naming
    // browser_click in their prose is legal only if this resolver can find it.
    for (const template of [...AGENT_INTERACTION_MESSAGES, ...INTERACTION_MESSAGES]) {
      if (template.capabilityKind === 'tool' && template.capability !== null) {
        expect(active.has(template.capability)).toBe(true);
      }
    }
    // The one kind whose advice is to wait rather than act declares no
    // capability at all, and that must stay acceptable.
    const busy = INTERACTION_MESSAGES.find(
      (entry) => entry.cause === 'obstructed-by-busy-indicator',
    );
    expect(busy?.capability).toBeNull();
    expect(busy?.capabilityKind).toBeNull();
    expect(buildYantraWrappedTools(services).map((tool) => tool.name)).toEqual([
      'browser_click',
      'browser_extract',
      'browser_fill_element',
      'browser_fill_form',
      'browser_navigate',
      'browser_observe',
      'result_publish',
      'script_run',
      'web_fetch',
      'web_search',
      'workflow_run',
    ]);
  });

  it('catalogs every literal interaction-layer errorCode in the scanned sources', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const paths = [
      ...sourceFiles(join(root, 'adapters', 'pi', 'tools')).filter((path) =>
        /browser-[^\\/]+\.ts$/.test(path),
      ),
      join(root, 'runtime', 'middleware.ts'),
      join(root, 'runtime', 'budget.ts'),
    ];
    const emitted = new Set<string>();
    for (const path of paths) {
      for (const match of readFileSync(path, 'utf8').matchAll(/errorCode:\s*'([^']+)'/g)) {
        if (match[1]) emitted.add(match[1]);
      }
    }
    const cataloged = new Set(AGENT_INTERACTION_MESSAGES.map((entry) => entry.code));
    const coreOwned = new Set(INTERACTION_MESSAGES.map((entry) => entry.code));
    const missing = [...emitted].filter((code) => !cataloged.has(code) && !coreOwned.has(code));
    expect(missing).toEqual([]);
  });

  it('does not repeat the publish remedy when a budget decision already carries it', () => {
    const message =
      'The run is out of exploration time. Publish now using the evidence already gathered.';
    const rendered = renderAgentMessage('middleware', 'BUDGET_EXHAUSTED', 'budget-decision', {
      message,
    });
    expect(rendered).toBe(message);
    expect(rendered.match(/publish now/gi)).toHaveLength(1);
  });
});

function detailsFor(code: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, representativeDetail(code, key)]));
}

/** A payload shaped the way the production caller actually supplies it. */
function representativeDetail(code: string, key: string): unknown {
  switch (key) {
    case 'repeated':
      return true;
    case 'timeoutMs':
    case 'offeredCount':
      return 123;
    case 'offered':
    case 'attempted':
      return ['alpha', 'beta'];
    case 'message':
      return `${code} catalog message`;
    case 'obstruction':
      return { role: 'dialog', name: 'Cookie choices' };
    case 'clearance_attempted':
      return false;
    case 'candidates':
      return [
        { ref: 'e41', role: 'button', name: 'Close', protected: false, auto_clearable: true },
      ];
    case 'kind':
      return 'modal-dialog';
    default:
      return `${key}-value`;
  }
}

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function buildServices(): RunServices {
  const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
  const sanitizer = new DefaultSanitizer();
  const provenance = new UrlProvenance();
  return {
    template: null,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir: '.',
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
        ethics: { check: () => Promise.resolve() },
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024,
        captureThresholdBytes: 1024,
      },
      script: { registry: new ScriptRegistry() },
      publish: { publish: () => Promise.reject(new Error('unused')) },
      workflow: null,
      browser: null,
      rank: null,
    },
  };
}
