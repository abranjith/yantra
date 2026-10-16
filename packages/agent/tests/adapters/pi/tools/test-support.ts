/**
 * Shared test support for the FEAT-024 tool suites: a RunServices builder with
 * overridable domain dependencies, small fakes for the core services, and the
 * reusable tool-contract harness (TASK-003).
 */

import type {
  ContentFetcher,
  EthicsGate,
  ExtractedArticle,
  FetchedDoc,
  Logger,
  PageAnalysis,
  PageExtractor,
  SearchProvider,
} from '@yantra/core';
import {
  DefaultSanitizer,
  DocumentStore,
  SearchService,
  type SearchProviderError,
  type UserInputVault,
} from '@yantra/core';
import { ScriptRegistry } from '@yantra/core';
import { err, ok, type TemplateManifest } from '@yantra/protocol';
import type { TObject } from 'typebox';
import { expect } from 'vitest';

import { type ActionLedger, actionLedgerFor } from '../../../../src/runtime/action-ledger.js';
import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from '../../../../src/runtime/budget.js';
import type { ContractCapabilityResolver } from '../../../../src/runtime/contract-capabilities.js';
import { FulfillmentRecord } from '../../../../src/runtime/fulfillment.js';
import type { ToolWrapperSpec, WrappedTool } from '../../../../src/runtime/middleware.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import { RunHealthLedger } from '../../../../src/runtime/run-health.js';
import {
  ActionPhase,
  EvidenceLedger,
  EvidencePhase,
  type FetchToolDeps,
  type PublishToolDeps,
  type RunServices,
  type SearchToolDeps,
  type ToolDomainDeps,
} from '../../../../src/runtime/run-services.js';
import { TaskContractStore } from '../../../../src/runtime/task-contract.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';
import { UrlPolicy } from '../../../../src/runtime/url-policy.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';
import type { VisionAvailability } from '../../../../src/runtime/vision.js';

export interface BuildServicesOptions {
  readonly runDir?: string;
  readonly limits?: Partial<BudgetLimits>;
  readonly abortSignal?: AbortSignal;
  readonly search?: Partial<SearchToolDeps>;
  readonly fetch?: Partial<FetchToolDeps>;
  readonly publish?: PublishToolDeps;
  readonly domain?: Partial<ToolDomainDeps>;
  readonly trace?: AgentTrace;
  readonly userInput?: UserInputVault;
  readonly template?: TemplateManifest | null;
  readonly vision?: Partial<VisionAvailability>;
  /**
   * Run-scoped URL provenance. Defaults to an empty one, so a test that expects
   * `browser_navigate` to succeed must record the target first — exactly as a
   * real run earns it from a tool result.
   */
  readonly urlProvenance?: UrlProvenance;
  readonly runHealth?: RunHealthLedger;
  /** The run document store; a fresh one per services bundle by default. */
  readonly documents?: DocumentStore;
  /**
   * The run's operator diagnostic logger. Absent by default, matching a
   * fixture that injects its own environment; supply a recorder to assert what
   * the middleware writes to `runtime.jsonl`.
   */
  readonly runtimeLogger?: Logger;
  /** The run's contract store; defaults to an unrequired, empty one. */
  readonly contract?: TaskContractStore;
  /** The run's action ledger; a fresh one located through the browser by default. */
  readonly actionLedger?: ActionLedger;
  /** Contract capability resolver; absent means the vision-backed default. */
  readonly contractCapabilities?: ContractCapabilityResolver;
}

/**
 * Run-scoped provenance that attests every URL on the given hosts, as
 * `--allow-host` does. For suites whose subject is not provenance itself:
 * since FEAT-051 `web_fetch` refuses an unattested URL, so a suite about
 * fetch plumbing must say where its URLs are attested from.
 */
export function attestedHosts(...hosts: readonly string[]): UrlProvenance {
  const provenance = new UrlProvenance();
  provenance.seed({ allowedHosts: hosts });
  return provenance;
}

/** Build a RunServices with sensible fakes and overridable domain deps. */
export function buildServices(options: BuildServicesOptions = {}): RunServices {
  const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, ...options.limits });
  const runDir = options.runDir ?? '/tmp/run-fixture';

  const search: SearchToolDeps = {
    service: searchServiceFor(emptySearchProvider()),
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
    rank: null,
    ...options.domain,
  };

  const sanitizer = new DefaultSanitizer();
  return {
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir,
    template: options.template ?? null,
    vision: {
      grantEnabled: false,
      hasBrowserTools: false,
      modelImageInput: false,
      suppressedByFlag: false,
      zeroLlm: false,
      available: false,
      capability: { imageInput: false, resolvedAt: 'pre-catalog' },
      ...options.vision,
    },
    budgets,
    sanitizer,
    ...(options.userInput ? { userInput: options.userInput } : {}),
    urlPolicy: new UrlPolicy(budgets),
    urlProvenance: options.urlProvenance ?? new UrlProvenance(),
    runHealth: options.runHealth ?? new RunHealthLedger(),
    documents: options.documents ?? new DocumentStore(),
    confirmation: null,
    actionPhase: new ActionPhase(),
    evidence: new EvidenceLedger(sanitizer),
    evidencePhase: new EvidencePhase(),
    trace: options.trace ?? new AgentTrace(),
    abortSignal: options.abortSignal ?? new AbortController().signal,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    domain,
    ...(options.runtimeLogger ? { runtimeLogger: options.runtimeLogger } : {}),
    contract:
      options.contract ??
      new TaskContractStore({
        runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        runDir,
        command: 'do',
        required: false,
      }),
    ...(options.contractCapabilities ? { contractCapabilities: options.contractCapabilities } : {}),
    fulfillment: new FulfillmentRecord(),
    actionLedger:
      options.actionLedger ??
      actionLedgerFor({
        controller: domain.browser?.controller ?? null,
        sanitizer,
        ...(options.userInput ? { userInput: options.userInput } : {}),
        nowIso: () => new Date().toISOString(),
        ...(options.runtimeLogger ? { logger: options.runtimeLogger } : {}),
      }),
  };
}

/** A {@link Logger} that keeps every structured payload it was handed. */
export function recordingRuntimeLogger(): Logger & {
  readonly lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const at = (level: string) => (obj: Record<string, unknown> | string) => {
    lines.push(typeof obj === 'string' ? { level, msg: obj } : { level, ...obj });
  };
  return {
    lines,
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
  };
}

/**
 * The run's search service over one provider (or one resolution failure), as
 * production wires it — gate, breaker, and memoized resolution included — with
 * the politeness wait made instant so unit suites do not sleep. Politeness
 * timing itself is pinned in core's `search-service.spec.ts`.
 */
export function searchServiceFor(
  provider: SearchProvider | SearchProviderError,
  options: { readonly logger?: Logger } = {},
): SearchService {
  return new SearchService({
    resolve: () => Promise.resolve(provider instanceof Error ? err(provider) : ok(provider)),
    logger: options.logger ?? silentLogger(),
    sleep: () => Promise.resolve(),
  });
}

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
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

/**
 * An extractor returning caller-supplied text (or null). Its shape-aware read
 * reports an `article` page holding that text and no other parts, so a suite
 * about tool plumbing sees today's article payload.
 */
export function extractorReturning(text: string | null): PageExtractor {
  const articleOf = (doc: FetchedDoc): ExtractedArticle | null =>
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
        };
  return {
    extract: (doc) => Promise.resolve(articleOf(doc)),
    extractPage: (doc) => {
      const article = articleOf(doc);
      return Promise.resolve({
        article,
        page: articlePageAnalysis(article?.contentText ?? null, doc.fetchMode),
      });
    },
  };
}

/** A page analysis with only article text (or nothing at all when `text` is null). */
export function articlePageAnalysis(
  text: string | null,
  fetchMode: 'http' | 'browser' = 'http',
): PageAnalysis {
  const hasText = text !== null && text.trim().length > 0;
  return {
    shape: hasText ? 'article' : null,
    records: [],
    structured: [],
    tables: [],
    fields: [],
    links: [],
    recordLinkCount: 0,
    readableText: text ?? '',
    coverage: {
      shape_basis: hasText ? 'article: fixture text' : 'empty: fixture page',
      fetch_mode: fetchMode,
      ...(hasText ? { text: { chars: text.length, shown: text.length } } : {}),
      not_found: hasText ? [] : ['no readable article'],
      omitted: [],
    },
  };
}

function nullExtractor(): PageExtractor {
  return extractorReturning(null);
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
    case 'browser_fill_element':
      return { field: 'Search', value: { kind: 'literal', value: 'hello' } };
    case 'browser_fill_form':
      return { fields: [{ field: 'Search', value: 'hello' }] };
    case 'browser_extract':
      return { kind: 'content' };
    case 'workflow_run':
      return { mode: 'list' };
    case 'task_contract':
      return { deliverable: 'answer', subject: 'x' };
    default:
      return {};
  }
}
