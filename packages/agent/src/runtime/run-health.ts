/**
 * Run-health ledger (FEAT-048): the run's own record of what happened to it.
 *
 * Every later fact the run reports about itself — the `tool_failure` warnings,
 * the Brief's runtime-derived notices, `run-health.json`, and the report's
 * "Run Health" section — is derived from this one ledger, so they cannot
 * disagree. It is fed from data already in hand at each chokepoint (the
 * middleware's terminal result, `web_search`'s per-site outcomes, the fetch
 * tools' successes, the browser provider's launches); recording adds no page
 * read, fetch, or browser call.
 *
 * Nothing recorded here may carry page text, a message, or a URL path/query:
 * causes are closed tokens, hosts are bare hostnames, and fetched URLs are
 * kept only in normalized form, solely to count repeat fetches.
 */

import type { PageShape } from '@yantra/core';
import {
  canonicalUrl,
  type BrowserProvider,
  type BrowserSession,
  type FetchTierEvent,
  type LaunchOptions,
  type SourceFailure,
} from '@yantra/core';
import { RUN_HEALTH_SCHEMA_VERSION, type BriefNotice, type RunHealth } from '@yantra/protocol';

import type { BudgetLimit, BudgetSnapshot } from './budget.js';

/** Terminal status of one tool call, with timeouts told apart from errors. */
export type ToolOutcomeStatus = 'ok' | 'error' | 'timeout' | 'aborted' | 'denied';

/** One tool call's outcome, recorded exactly once by the middleware. */
export interface ToolOutcomeRecord {
  readonly tool: string;
  readonly status: ToolOutcomeStatus;
  /** Stable error code, on non-`ok` outcomes. */
  readonly code?: string;
  /** Closed cause token, on non-`ok` outcomes. */
  readonly cause?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly budgetLimit?: string;
  readonly fetchMode?: 'http' | 'browser';
}

/** One per-site read failure inside a multi-source tool (`web_search`). */
export interface SourceFailureRecord {
  readonly tool: string;
  readonly host: string;
  readonly stage: SourceFailure['stage'];
  /** Stable, page-text-free reason (the first one wins in notices). */
  readonly reason: string;
}

/** One real network page fetch. */
export interface FetchRecord {
  readonly normalizedUrl: string;
  readonly mode: 'http' | 'browser';
}

/** The first tool to hit a budget limit, and the reads it skipped. */
export interface BudgetExhaustionRecord {
  readonly firstTool: string;
  readonly skippedReads: number;
}

/** The run's configured navigation/host ceilings, quoted in budget notices. */
export interface RunHealthLimits {
  readonly maxNavigations?: number;
  readonly maxHosts?: number;
}

/**
 * Per-run accumulator. One instance per run, required on `RunServices`.
 */
export class RunHealthLedger {
  public constructor(private readonly limits: RunHealthLimits = {}) {}

  private readonly outcomes: ToolOutcomeRecord[] = [];
  private readonly sourceFailureList: SourceFailureRecord[] = [];
  private readonly fetchList: FetchRecord[] = [];
  private readonly exhaustions = new Map<BudgetLimit, BudgetExhaustionRecord>();
  private readonly providers: string[] = [];
  private launches = 0;
  private cacheHits = 0;
  private memoHits = 0;
  private readonly tierEvents: FetchTierEvent[] = [];
  private publishedNotices = 0;
  private readonly pagesByShape = new Map<PageShape, number>();
  private recordsShown = 0;
  private linksOffered = 0;
  private linksWithheld = 0;
  private discoveredFollows = 0;
  /** Every budget limit that refused a call, in first-hit order. */
  private readonly exhaustedOrder: string[] = [];

  /** Record one terminal tool outcome (the middleware's chokepoint calls this). */
  /**
   * Count one shape-aware page view returned to the model (FEAT-051): its
   * shape, the records it showed, and the links it offered or withheld.
   *
   * @param shape The page's shape.
   * @param stats What the projected view showed.
   */
  public recordPage(
    shape: PageShape,
    stats: {
      readonly recordsShown: number;
      readonly linksOffered: number;
      readonly linksWithheld: number;
    },
  ): void {
    this.pagesByShape.set(shape, (this.pagesByShape.get(shape) ?? 0) + 1);
    this.recordsShown += stats.recordsShown;
    this.linksOffered += stats.linksOffered;
    this.linksWithheld += stats.linksWithheld;
  }

  /**
   * Count one successful `web_fetch` or `browser_navigate` to a URL a read
   * page offered (plan §11, "turns spent seeking unreachable URLs", measured
   * from the side that now succeeds).
   */
  public recordDiscoveredFollow(): void {
    this.discoveredFollows += 1;
  }

  /** The extraction counters, or undefined when no shape-aware read happened. */
  private extractionSummary(): RunHealth['extraction'] {
    if (this.pagesByShape.size === 0 && this.discoveredFollows === 0) return undefined;
    return {
      pages_by_shape: Object.fromEntries(this.pagesByShape),
      records_shown: this.recordsShown,
      links_offered: this.linksOffered,
      links_withheld: this.linksWithheld,
      discovered_follows: this.discoveredFollows,
    };
  }

  public recordToolOutcome(record: ToolOutcomeRecord): void {
    this.outcomes.push(record);
    if (record.code === 'BUDGET_EXHAUSTED' && record.budgetLimit !== undefined) {
      this.noteExhausted(record.budgetLimit);
    }
    if (record.tool === 'web_search' && record.provider !== undefined) {
      this.noteProvider(record.provider);
    }
  }

  /** Record one per-site read failure (not a budget refusal: see below). */
  public recordSourceFailure(record: SourceFailureRecord): void {
    this.sourceFailureList.push(record);
  }

  /**
   * Record one real network page fetch. Called only from inside a document
   * store load, so it counts the network, never a read the store answered.
   *
   * @param url The fetched URL; only its canonical form is kept.
   * @param mode Whether the HTTP tier or the browser served it.
   */
  public recordFetch(url: string, mode: 'http' | 'browser'): void {
    this.fetchList.push({ normalizedUrl: canonicalUrl(url), mode });
  }

  /** Count one read the run document store answered with no network fetch. */
  public recordCacheHit(): void {
    this.cacheHits += 1;
  }

  /** Count one read answered from an earlier read's remembered terminal failure. */
  public recordMemoHit(): void {
    this.memoHits += 1;
  }

  /**
   * Record one tier decision of the run's hybrid fetcher (FEAT-050): an
   * escalation to the browser, or a challenge page at either tier. Hosts only.
   */
  public recordTierEvent(event: FetchTierEvent): void {
    this.tierEvents.push(event);
  }

  /** Every tier event, in record order. */
  public fetchTierEvents(): readonly FetchTierEvent[] {
    return [...this.tierEvents];
  }

  /** Reads answered from the document store so far. */
  public cacheHitCount(): number {
    return this.cacheHits;
  }

  /** Reads answered from the failure memo so far. */
  public memoHitCount(): number {
    return this.memoHits;
  }

  /**
   * Record that a budget limit refused reads. The first tool to hit a limit is
   * kept; later refusals of the same limit add their skipped reads.
   */
  public recordBudgetExhaustion(limit: BudgetLimit, tool: string, skippedReads: number): void {
    this.noteExhausted(limit);
    const existing = this.exhaustions.get(limit);
    this.exhaustions.set(limit, {
      firstTool: existing?.firstTool ?? tool,
      skippedReads: (existing?.skippedReads ?? 0) + Math.max(0, Math.floor(skippedReads)),
    });
  }

  /**
   * Record how many runtime-derived notices the published document carries.
   * Taken from the facts actually attached at publish time, never recomputed
   * at teardown (later tool calls would change the count).
   */
  public recordPublishedNotices(count: number): void {
    this.publishedNotices = Math.max(0, Math.floor(count));
  }

  /** Runtime-derived notices on the published document; 0 when nothing published. */
  public publishedNoticeCount(): number {
    return this.publishedNotices;
  }

  /** Count one successful browser process launch. */
  public recordBrowserLaunch(): void {
    this.launches += 1;
  }

  /** Every tool outcome, in call-completion order. */
  public toolOutcomes(): readonly ToolOutcomeRecord[] {
    return [...this.outcomes];
  }

  /** Every per-site failure, in record order. */
  public sourceFailures(): readonly SourceFailureRecord[] {
    return [...this.sourceFailureList];
  }

  /** Every network fetch, in record order. */
  public fetches(): readonly FetchRecord[] {
    return [...this.fetchList];
  }

  /** Exhausted limits, in first-exhaustion order. */
  public budgetExhaustions(): ReadonlyMap<BudgetLimit, BudgetExhaustionRecord> {
    return new Map(this.exhaustions);
  }

  /** Successful browser launches so far. */
  public browserLaunches(): number {
    return this.launches;
  }

  /** Distinct search providers used, in first-use order. */
  public searchProviders(): readonly string[] {
    return [...this.providers];
  }

  /** Network fetches of a canonical URL already fetched earlier in the run. */
  public repeatFetches(): number {
    const seen = new Set<string>();
    let repeats = 0;
    for (const fetch of this.fetchList) {
      if (seen.has(fetch.normalizedUrl)) repeats += 1;
      else seen.add(fetch.normalizedUrl);
    }
    return repeats;
  }

  /**
   * `web_search` outcomes that actually attempted a search: latch and schema
   * refusals (the provider was never asked) and aborted/denied calls are not
   * searches, so they count neither as successes nor as failures.
   */
  public attemptedSearches(): readonly ToolOutcomeRecord[] {
    return this.outcomes.filter(
      (outcome) =>
        outcome.tool === 'web_search' &&
        (outcome.status === 'ok' || outcome.status === 'error' || outcome.status === 'timeout') &&
        !(outcome.code !== undefined && NOT_ATTEMPTED_CODES.has(outcome.code)),
    );
  }

  /**
   * The facts the runtime attaches to a published document: notices for every
   * search-failure code, every exhausted budget, and every per-source read
   * failure, plus the search provider. Derived deterministically from fixed
   * phrase tables, counts, and hostnames — never from page or provider text —
   * so nothing untrusted enters the document through this path.
   *
   * Order: `leading` (whole-run notices the caller owns, such as the
   * missing-contract notice), then search failures, budget exhaustion,
   * challenge pages, per-source reads. At most
   * {@link MAX_RUNTIME_NOTICES}; the overflow becomes one `other` notice that
   * points at the report's Run Health section.
   */
  public briefFacts(leading: readonly BriefNotice[] = []): RuntimeBriefFacts {
    const notices = [
      ...leading,
      ...this.searchFailureNotices(),
      ...this.budgetNotices(),
      ...this.challengeNotices(),
      ...this.readFailureNotices(),
    ];
    // The overflow replaces the tenth slot, so it always stands for at least two.
    const overflow = notices.length - (MAX_RUNTIME_NOTICES - 1);
    const capped =
      notices.length <= MAX_RUNTIME_NOTICES
        ? notices
        : [
            ...notices.slice(0, MAX_RUNTIME_NOTICES - 1),
            {
              kind: 'other' as const,
              source: 'runtime',
              reason:
                `${plural(overflow, 'more run notice')} ` +
                `${overflow === 1 ? 'is' : 'are'} summarized in report.md under Run Health.`,
            },
          ];
    return {
      notices: capped,
      searchProvider: this.providers.length === 0 ? null : this.providers.join(', '),
    };
  }

  private searchFailureNotices(): BriefNotice[] {
    const attempted = this.attemptedSearches();
    const byCode = new Map<string, ToolOutcomeRecord[]>();
    for (const outcome of attempted) {
      if (outcome.status === 'ok' || outcome.code === undefined) continue;
      const group = byCode.get(outcome.code) ?? [];
      group.push(outcome);
      byCode.set(outcome.code, group);
    }
    return [...byCode].map(([code, failures]) => {
      // A middleware timeout carries no provider; the run's own provider is
      // the one that was being asked.
      const provider =
        failures.find((failure) => failure.provider !== undefined)?.provider ?? this.providers[0];
      // Searches the breaker refused were never sent (FEAT-050): they are
      // named after the cause that opened it, not counted as more challenges.
      const skipped = failures.filter((failure) => failure.cause === 'circuit-open').length;
      const sent = failures.find((failure) => failure.cause !== 'circuit-open');
      const lead =
        sent === undefined
          ? `${plural(skipped, 'later search', 'later searches')} ${skipped === 1 ? 'was' : 'were'} ` +
            "not attempted after the provider's challenge"
          : `${searchCausePhrase(sent.cause)}` +
            (skipped === 0
              ? ''
              : `; ${plural(skipped, 'later search', 'later searches')} ` +
                `${skipped === 1 ? 'was' : 'were'} not attempted after the provider's challenge`);
      return {
        kind: 'search_failed' as const,
        source: provider === undefined ? 'search' : `search:${provider}`,
        reason:
          `${failures.length} of ${plural(attempted.length, 'web search', 'web searches')} ` +
          `failed: ${lead} (${code}).`,
      };
    });
  }

  private budgetNotices(): BriefNotice[] {
    const notices: BriefNotice[] = [];
    for (const [limit, record] of this.exhaustions) {
      if (limit !== 'navigations' && limit !== 'hosts') continue;
      const ceiling = limit === 'navigations' ? this.limits.maxNavigations : this.limits.maxHosts;
      const name = limit === 'navigations' ? 'navigation' : 'distinct-host';
      const skipped = record.skippedReads;
      notices.push({
        kind: 'budget_exhausted',
        source: 'runtime',
        reason:
          `Yantra's ${name} budget${ceiling === undefined ? '' : ` (${ceiling})`} was exhausted; ` +
          `${plural(skipped, 'further page read')} ${skipped === 1 ? 'was' : 'were'} not attempted.`,
      });
    }
    return notices;
  }

  /**
   * Challenge pages (FEAT-050, policy b). One `blocked` notice per host whose
   * standard browser was served a challenge (the page was not read), and one
   * `other` notice per host that challenged only the HTTP client and was then
   * read in the browser — the disclosure the signed-off policy requires.
   */
  private challengeNotices(): BriefNotice[] {
    const browserBlocked = new Map<string, number>();
    const httpOnly = new Set<string>();
    for (const event of this.tierEvents) {
      if (event.kind !== 'challenge' || event.host.length === 0) continue;
      if (event.tier === 'browser') {
        browserBlocked.set(event.host, (browserBlocked.get(event.host) ?? 0) + 1);
      } else {
        httpOnly.add(event.host);
      }
    }
    const renderedHosts = new Set(
      this.fetchList
        .filter((fetch) => fetch.mode === 'browser')
        .map((fetch) => hostOfUrl(fetch.normalizedUrl)),
    );
    const notices: BriefNotice[] = [];
    for (const [host, pages] of browserBlocked) {
      notices.push({
        kind: 'blocked',
        source: host,
        reason:
          `${host} served a human-verification page to Yantra's standard browser; ` +
          `${plural(pages, 'page')} ${pages === 1 ? 'was' : 'were'} not read.`,
      });
    }
    for (const host of httpOnly) {
      if (browserBlocked.has(host) || !renderedHosts.has(host)) continue;
      notices.push({
        kind: 'other',
        source: host,
        reason:
          `${host} refused Yantra's HTTP client with a human-verification page; ` +
          'the page was read once in the standard browser.',
      });
    }
    return notices;
  }

  private readFailureNotices(): BriefNotice[] {
    const failures: ReadFailure[] = [];
    for (const record of this.sourceFailureList) {
      const failure = readFailureFromSource(record);
      if (failure !== null) failures.push(failure);
    }
    for (const outcome of this.outcomes) {
      if (outcome.tool !== 'web_fetch' || outcome.status === 'ok') continue;
      if (outcome.status !== 'error' && outcome.status !== 'timeout') continue;
      const failure = readFailureFromFetch(outcome);
      if (failure !== null) failures.push(failure);
    }
    const groups = new Map<string, { readonly first: ReadFailure; count: number }>();
    for (const failure of failures) {
      const key = `${failure.kind}|${failure.host}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { first: failure, count: 1 });
      else group.count += 1;
    }
    return [...groups.values()].map((group) =>
      readNotice(group.first, group.count, group.first.reason),
    );
  }

  /**
   * The run's health summary, persisted as `run-health.json` and logged once
   * as the `run_health` event. `searches.total` is always `ok` plus the sum
   * of `failed_by_code`, and `fetches.total` the sum of `by_mode`.
   *
   * @param input Run id, budget consumption and ceilings, and the notice count
   *   recorded when the document was published.
   */
  public summary(input: {
    readonly runId: string;
    readonly snapshot: Pick<BudgetSnapshot, 'navigations' | 'hosts'>;
    readonly limits: { readonly maxNavigations: number; readonly maxHosts: number };
    readonly noticeCount: number;
    /** The background page pool's final counters (FEAT-050), when the run had one. */
    readonly pagePool?: { readonly launches: number; readonly contexts: number };
    /** The run search service's final counters (FEAT-050). */
    readonly search?: { readonly breakerSkipped: number; readonly peakConcurrency: number };
  }): RunHealth {
    const searches = this.attemptedSearches();
    const searchFailures = countByCode(searches.filter((outcome) => outcome.status !== 'ok'));
    const fetchFailures = countByCode(
      this.outcomes.filter(
        (outcome) =>
          outcome.tool === 'web_fetch' &&
          (outcome.status === 'error' || outcome.status === 'timeout'),
      ),
    );
    const toolFailures = this.outcomes.filter(
      (outcome) => outcome.status === 'error' || outcome.status === 'timeout',
    );
    const stages = { fetch: 0, extract: 0, blocked: 0, budget: 0, policy: 0 };
    for (const failure of this.sourceFailureList) stages[failure.stage] += 1;
    for (const record of this.exhaustions.values()) stages.budget += record.skippedReads;
    const http = this.fetchList.filter((fetch) => fetch.mode === 'http').length;
    const extraction = this.extractionSummary();
    return {
      schema_version: RUN_HEALTH_SCHEMA_VERSION,
      run_id: input.runId,
      searches: {
        total: searches.length,
        ok: searches.filter((outcome) => outcome.status === 'ok').length,
        failed_by_code: searchFailures,
        providers: [...this.providers],
        ...(input.search === undefined
          ? {}
          : {
              breaker_skipped: input.search.breakerSkipped,
              peak_concurrency: input.search.peakConcurrency,
            }),
      },
      fetches: {
        total: this.fetchList.length,
        by_mode: { http, browser: this.fetchList.length - http },
        repeat_fetches: this.repeatFetches(),
        failed_by_code: fetchFailures,
        cache_hits: this.cacheHits,
        memo_hits: this.memoHits,
        challenges: {
          http: this.challengeCount('http'),
          browser: this.challengeCount('browser'),
        },
      },
      source_failures: stages,
      browser: {
        launches: this.launches,
        ...(input.pagePool === undefined
          ? {}
          : { pool_launches: input.pagePool.launches, contexts: input.pagePool.contexts }),
      },
      budgets: {
        navigations_used: input.snapshot.navigations,
        navigations_limit: nonNegativeInt(input.limits.maxNavigations),
        hosts_used: input.snapshot.hosts,
        hosts_limit: nonNegativeInt(input.limits.maxHosts),
        exhausted: [...this.exhaustedOrder],
      },
      tool_failures: { total: toolFailures.length, by_code: countByCode(toolFailures) },
      notices: Math.max(0, Math.floor(input.noticeCount)),
      ...(extraction === undefined ? {} : { extraction }),
    };
  }

  private challengeCount(tier: 'http' | 'browser'): number {
    return this.tierEvents.filter((event) => event.kind === 'challenge' && event.tier === tier)
      .length;
  }

  private noteExhausted(limit: string): void {
    if (!this.exhaustedOrder.includes(limit)) this.exhaustedOrder.push(limit);
  }

  private noteProvider(provider: string): void {
    if (!this.providers.includes(provider)) this.providers.push(provider);
  }
}

/** Counts of outcomes by stable code; an outcome without a code counts as `UNKNOWN`. */
function countByCode(outcomes: readonly ToolOutcomeRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const code = outcome.code ?? 'UNKNOWN';
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** A configured ceiling as a JSON-safe count (an unbounded ceiling reads as 0). */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Wrap a browser provider so every successful launch is counted in the run's
 * ledger. A pure pass-through: it delegates every member of `BrowserProvider`
 * unchanged and adds no browser work. One wrapped provider is shared by the
 * agent's browser controller, the scraped-search transport, and the fetch
 * fallback, so one decorator counts all three.
 *
 * @param provider The run's browser provider.
 * @param ledger The run's health ledger.
 */
export function countingBrowserProvider(
  provider: BrowserProvider,
  ledger: RunHealthLedger,
): BrowserProvider {
  return {
    launch: async (options: Partial<LaunchOptions>): Promise<BrowserSession> => {
      const session = await provider.launch(options);
      ledger.recordBrowserLaunch();
      return session;
    },
    detectChrome: () => provider.detectChrome(),
  };
}

/** Most runtime-derived notices one document carries; the rest overflow into one. */
export const MAX_RUNTIME_NOTICES = 10;

/** Run facts attached to a published document by the runtime, never by the model. */
export interface RuntimeBriefFacts {
  readonly notices: readonly BriefNotice[];
  /** Distinct search providers used, joined by `, `; null when no search ran. */
  readonly searchProvider: string | null;
}

/**
 * Codes for a `web_search` call that never attempted a search (the request
 * was refused before the provider was asked). They are not search failures.
 */
const NOT_ATTEMPTED_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'EVIDENCE_FROZEN',
  'ACTION_PHASE_CLOSED',
]);

/** Fixed per-cause phrases for search-failure notices (never provider prose). */
const SEARCH_CAUSE_PHRASES: Readonly<Record<string, string>> = {
  'anomaly-challenge': 'the provider served an anti-bot challenge',
  'rate-limited': 'the provider rate-limited the searches',
  'empty-results': 'the provider returned no results',
  timeout: 'the search timed out',
  'per-tool-timeout': 'the search exceeded its time budget',
  'key-missing': 'the provider needs an API key that is not configured',
  'no-provider-available': 'no search provider was available',
  'unknown-provider': 'the configured search provider is not recognized',
  'auth-rejected': 'the provider rejected the configured API key',
  'http-5xx': 'the provider returned a server error',
  'http-4xx': 'the provider refused the request',
  'invalid-response': 'the provider returned an unreadable response',
  'serp-fetch-failed': 'the results page failed to load',
  aborted: 'the search was cancelled',
  'browser-startup': 'the browser used for search could not start',
};

function searchCausePhrase(cause: string | undefined): string {
  if (cause === undefined) return 'the search failed';
  const fixed = SEARCH_CAUSE_PHRASES[cause];
  if (fixed !== undefined) return fixed;
  if (cause.startsWith('ethics-refused:')) return "Yantra's ethics policy refused the search page";
  if (cause.startsWith('budget:')) return "Yantra's run budget refused the search";
  if (cause.startsWith('unexpected:')) return 'an unclassified error occurred';
  return 'the search failed';
}

/** Per-source read failure, normalized across `web_search` sites and `web_fetch` calls. */
interface ReadFailure {
  readonly kind: 'fetch_failed' | 'extract_failed' | 'blocked' | 'other';
  readonly host: string;
  readonly reason: string;
}

/** Stable per-source reasons `processSource` produces; anything else is replaced. */
const STABLE_READ_REASON_RE =
  /^(fetch timed out|fetch failed|source returned HTTP (\d{3}|error)|source payload exceeded the size limit|could not extract a readable article)$/;

const ETHICS_PHRASES: Readonly<Record<string, string>> = {
  robots: "refused by the site's robots.txt",
  'rate-limit': "held back by the site's rate limit",
  blocklist: "the host is on Yantra's blocklist",
};

function readFailureFromSource(record: SourceFailureRecord): ReadFailure | null {
  switch (record.stage) {
    case 'budget':
      return null; // reported once as budget exhaustion
    case 'policy':
      return { kind: 'other', host: record.host, reason: 'policy' };
    case 'blocked': {
      // A challenge page is reported once, by host, from the tier events.
      if (record.reason.startsWith('challenge page')) return null;
      const reason = record.reason.split(' - ')[0] ?? '';
      return {
        kind: 'blocked',
        host: record.host,
        reason: ETHICS_PHRASES[reason] ?? 'refused by the access policy',
      };
    }
    case 'fetch':
      return {
        kind: 'fetch_failed',
        host: record.host,
        reason: STABLE_READ_REASON_RE.test(record.reason) ? record.reason : 'fetch failed',
      };
    case 'extract':
      return {
        kind: 'extract_failed',
        host: record.host,
        reason: STABLE_READ_REASON_RE.test(record.reason)
          ? record.reason
          : 'could not extract a readable article',
      };
  }
}

/** `web_fetch` failure codes, by notice kind and fixed phrase. */
const FETCH_CODE_READS: Readonly<Record<string, Pick<ReadFailure, 'kind' | 'reason'>>> = {
  FETCH_TIMEOUT: { kind: 'fetch_failed', reason: 'fetch timed out' },
  TOOL_TIMEOUT: { kind: 'fetch_failed', reason: 'the fetch exceeded its time budget' },
  FETCH_HTTP_ERROR: { kind: 'fetch_failed', reason: 'the server returned an HTTP error' },
  FETCH_FAILED: { kind: 'fetch_failed', reason: 'fetch failed' },
  CONTENT_TOO_LARGE: { kind: 'fetch_failed', reason: 'the page exceeded the size limit' },
  CONTENT_TYPE_REFUSED: { kind: 'extract_failed', reason: 'the page was not text content' },
  EXTRACTION_EMPTY: { kind: 'extract_failed', reason: 'could not extract a readable article' },
};

function readFailureFromFetch(outcome: ToolOutcomeRecord): ReadFailure | null {
  if (outcome.host === undefined || outcome.code === undefined) return null;
  if (outcome.code === 'BUDGET_EXHAUSTED') return null; // reported as budget exhaustion
  // A replay of an earlier read's terminal failure fetched nothing: the first
  // attempt already produced this notice.
  if (outcome.cause === 'already-attempted') return null;
  // A challenge page is reported once, by host, from the tier events.
  if (outcome.code === 'SITE_CHALLENGE') return null;
  if (outcome.code === 'ETHICS_BLOCKED') {
    const reason = outcome.cause?.replace(/^ethics-refused:/, '') ?? '';
    return {
      kind: 'blocked',
      host: outcome.host,
      reason: ETHICS_PHRASES[reason] ?? 'refused by the access policy',
    };
  }
  if (outcome.code.startsWith('URL_'))
    return { kind: 'other', host: outcome.host, reason: 'policy' };
  const mapped = FETCH_CODE_READS[outcome.code];
  return mapped === undefined ? null : { ...mapped, host: outcome.host };
}

/** The hostname of a canonical URL, or the empty string. */
function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // swallow-ok: an unparseable recorded URL simply matches no host.
    return '';
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function readNotice(failure: ReadFailure, count: number, firstReason: string): BriefNotice {
  const reads = plural(count, 'page read');
  switch (failure.kind) {
    case 'other':
      return {
        kind: 'other',
        source: failure.host,
        reason: `Yantra's URL policy refused ${reads} on ${failure.host}.`,
      };
    case 'blocked':
      return {
        kind: 'blocked',
        source: failure.host,
        reason: `${reads} on ${failure.host} ${count === 1 ? 'was' : 'were'} not made: ${firstReason}.`,
      };
    case 'extract_failed':
      return {
        kind: 'extract_failed',
        source: failure.host,
        reason: `${reads} on ${failure.host} produced no readable content: ${firstReason}.`,
      };
    case 'fetch_failed':
      return {
        kind: 'fetch_failed',
        source: failure.host,
        reason: `${reads} on ${failure.host} failed: ${firstReason}.`,
      };
  }
}
