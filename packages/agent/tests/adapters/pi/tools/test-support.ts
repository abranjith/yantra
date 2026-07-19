/**
 * Shared test support for the FEAT-024 tool suites: a RunServices builder with
 * overridable domain dependencies, small fakes for the core services, and the
 * reusable tool-contract harness (TASK-003).
 */

import type {
  ContentFetcher,
  EthicsGate,
  Extractor,
  FetchedDoc,
  SearchProvider,
} from '@yantra/core';
import { DefaultSanitizer } from '@yantra/core';
import { ScriptRegistry } from '@yantra/core';
import type { TObject } from 'typebox';
import { expect } from 'vitest';

import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from '../../../../src/runtime/budget.js';
import type { ToolWrapperSpec, WrappedTool } from '../../../../src/runtime/middleware.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import {
  ActionPhase,
  type FetchToolDeps,
  type PublishToolDeps,
  type RunServices,
  type SearchToolDeps,
  type ToolDomainDeps,
} from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';
import { UrlPolicy } from '../../../../src/runtime/url-policy.js';

export interface BuildServicesOptions {
  readonly runDir?: string;
  readonly limits?: Partial<BudgetLimits>;
  readonly abortSignal?: AbortSignal;
  readonly search?: Partial<SearchToolDeps>;
  readonly fetch?: Partial<FetchToolDeps>;
  readonly publish?: PublishToolDeps;
  readonly domain?: Partial<ToolDomainDeps>;
  readonly trace?: AgentTrace;
}

/** Build a RunServices with sensible fakes and overridable domain deps. */
export function buildServices(options: BuildServicesOptions = {}): RunServices {
  const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, ...options.limits });
  const runDir = options.runDir ?? '/tmp/run-fixture';

  const search: SearchToolDeps = {
    resolveProvider: () => Promise.resolve({ isOk: true, value: emptySearchProvider() }),
    resultCap: 5,
    fetchTop: 3,
    ...options.search,
  };
  const fetch: FetchToolDeps = {
    fetcher: throwingFetcher(),
    extractor: nullExtractor(),
    ethics: allowingEthics(),
    allowedContentTypes: ['text/html', 'text/plain'],
    maxContentBytes: 5 * 1024 * 1024,
    captureThresholdBytes: 16 * 1024,
    ...options.fetch,
  };
  const domain: ToolDomainDeps = {
    search,
    fetch,
    script: { registry: new ScriptRegistry() },
    publish: options.publish ?? nullPublisher(),
    browser: null,
    workflow: null,
    ...options.domain,
  };

  return {
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir,
    budgets,
    sanitizer: new DefaultSanitizer(),
    urlPolicy: new UrlPolicy(budgets),
    confirmation: null,
    actionPhase: new ActionPhase(),
    trace: options.trace ?? new AgentTrace(),
    abortSignal: options.abortSignal ?? new AbortController().signal,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    domain,
  };
}

/** A search provider returning a caller-supplied hit list. */
export function searchProviderReturning(
  hits: Awaited<ReturnType<SearchProvider['search']>>,
): SearchProvider {
  return { name: 'duckduckgo', search: () => Promise.resolve(hits) };
}

function emptySearchProvider(): SearchProvider {
  return { name: 'duckduckgo', search: () => Promise.resolve([]) };
}

/** A fetcher that returns a caller-supplied document. */
export function fetcherReturning(doc: FetchedDoc): ContentFetcher {
  return { fetch: () => Promise.resolve(doc) };
}

function throwingFetcher(): ContentFetcher {
  return {
    fetch: () => Promise.reject(new Error('fetcher not configured for this test')),
  };
}

/** An extractor returning caller-supplied text (or null). */
export function extractorReturning(text: string | null): Extractor {
  return {
    extract: (doc) =>
      Promise.resolve(
        text === null
          ? null
          : {
              url: doc.finalUrl,
              title: 'Fixture Title',
              byline: null,
              publishedAt: null,
              siteName: null,
              contentText: text,
              contentHtml: `<p>${text}</p>`,
              excerpt: text.slice(0, 100),
              lengthChars: text.length,
            },
      ),
  };
}

function nullExtractor(): Extractor {
  return { extract: () => Promise.resolve(null) };
}

/** An ethics gate that allows everything. */
export function allowingEthics(): EthicsGate {
  return { check: () => Promise.resolve() };
}

/** An ethics gate that refuses via EthicsRefusedError. */
export function refusingEthics(error: unknown): EthicsGate {
  return { check: () => Promise.reject(error) };
}

function nullPublisher(): PublishToolDeps {
  return {
    publish: () =>
      Promise.resolve({
        isOk: false,
        error: { name: 'BriefValidationError', message: 'no publisher', issues: [] } as never,
      }),
  };
}

/** Build a FetchedDoc fixture. */
export function fetchedDoc(overrides: Partial<FetchedDoc> = {}): FetchedDoc {
  return {
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    fetchedAt: new Date().toISOString(),
    contentType: 'text/html; charset=utf-8',
    html: '<html><body><article>hello world</article></body></html>',
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 5,
    ...overrides,
  };
}

/**
 * The reusable tool-contract harness (TASK-003). Asserts every declared-contract
 * invariant a wrapped tool must satisfy: schema closedness, description quality,
 * snake_case name, stable INVALID_INPUT code, and prompt-abort cancellation.
 *
 * @param spec The tool spec under test.
 * @param invalidInput A value that violates the tool's schema.
 */
export async function assertToolContract(
  spec: ToolWrapperSpec<TObject>,
  invalidInput: unknown,
): Promise<void> {
  // Name is snake_case.
  expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/);

  // Input schema is a closed object.
  const schema = spec.parameters as { type?: string; additionalProperties?: unknown };
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties).toBe(false);

  // Description states when NOT to use it (quality gate).
  expect(spec.description.length).toBeGreaterThan(40);
  expect(spec.description).toMatch(/do not|don't|not use/i);

  // Invalid input yields the stable INVALID_INPUT code without side effects.
  const services = buildServices();
  const invalidTool: WrappedTool = wrapTool(spec, services);
  const invalidResult = await invalidTool.execute(invalidInput, undefined);
  expect(invalidResult.status).toBe('error');
  expect(invalidResult.error_code).toBe('INVALID_INPUT');

  // A pre-aborted run signal short-circuits to `aborted`.
  const controller = new AbortController();
  controller.abort();
  const abortedServices = buildServices({ abortSignal: controller.signal });
  const abortedTool = wrapTool(spec, abortedServices);
  const abortedResult = await abortedTool.execute(minimalValidFor(spec), undefined);
  expect(abortedResult.status).toBe('aborted');
}

/** Produce a schema-valid minimal input for a tool (for the cancellation check). */
function minimalValidFor(spec: ToolWrapperSpec<TObject>): Record<string, unknown> {
  switch (spec.name) {
    case 'web_search':
      return { query: 'x' };
    case 'web_fetch':
      return { url: 'https://example.com/' };
    case 'script_run':
      return { script_id: 'table_normalize', args: { text: 'a\n1' } };
    case 'result_publish':
      return { brief: { title: 'x', overview: 'x' } };
    case 'browser_navigate':
      return { url: 'https://example.com/' };
    case 'browser_observe':
      return {};
    case 'browser_click':
      return { ref: 'e1' };
    case 'browser_fill':
      return { ref: 'e1', value: { kind: 'literal', value: 'hello' } };
    case 'browser_extract':
      return { kind: 'content' };
    case 'workflow_run':
      return { mode: 'list' };
    default:
      return {};
  }
}
