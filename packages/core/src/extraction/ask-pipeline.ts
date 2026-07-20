import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief, FailureClass, TaskEvent } from '@yantra/protocol';
import { appendNotice, generateUlid } from '@yantra/protocol';

import { writeBriefArtifacts, type BriefArtifactPaths } from '../brief/write-artifacts.js';
import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import { JsonlEventBus } from '../executor/event-bus.js';
import {
  domainFromUrl,
  rankReasonForFailureStage,
  safeRecordRankSignal,
} from '../ranking/recording.js';
import type { RankSignalSink } from '../ranking/types.js';
import type { Synthesizer } from '../synthesis/types.js';

import { cacheKey, utcDayFrom } from './cache-key.js';
import type { AskCache } from './cache.js';
import type { AskEthicsGate } from './ethics-adapter.js';
import { FetchError, type ContentFetcher } from './fetcher.js';
import type { Extractor } from './readability.js';
import { SearchProviderError } from './search/errors.js';
import type { SearchProvider } from './search/registry.js';
import { processSource, type ProcessedSource } from './source-processor.js';
import type { AskQuery, SearchResult } from './types.js';

/** The result of one ask run: the Brief plus its persisted artifact paths. */
export interface AskRunResult {
  /** The synthesized Brief document. */
  readonly brief: Brief;
  /** Paths of the written brief.json/md/html, or null when the write failed. */
  readonly artifacts: BriefArtifactPaths | null;
}

export class AskPipelineError extends Error {
  public override readonly name = 'AskPipelineError';

  public constructor(
    message: string,
    public readonly failureClass: FailureClass,
    public readonly context: {
      readonly runDir: string;
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}

interface AskPipelineDependencies {
  readonly searchProvider: SearchProvider;
  readonly fetcher: ContentFetcher;
  readonly extractor: Extractor;
  readonly cache: AskCache;
  readonly ethicsGate: AskEthicsGate;
  readonly logger: Logger;
  /**
   * The Synthesize stage (FEAT-014). Turns the search/fetch/extract output into
   * one Brief. Callers select the strategy (deterministic vs LLM) via
   * `selectSynthesizer` and pass the chosen instance here.
   */
  readonly synthesizer: Synthesizer;
  /** Optional observation-only domain ranking sink. */
  readonly rankSink?: RankSignalSink;
  readonly runRootDir?: string;
  readonly clock?: () => Date;
}

/**
 * Orchestrates the ask pipeline: `Search → Fetch → Extract → Synthesize →
 * (persist) → Brief`. Per-source failures are isolated and surfaced as honest
 * Brief notices rather than dropped; a budget timeout yields a partial Brief
 * carrying a `budget_exhausted` notice instead of a hard error.
 */
export class AskPipeline {
  private readonly searchProvider: SearchProvider;
  private readonly fetcher: ContentFetcher;
  private readonly extractor: Extractor;
  private readonly cache: AskCache;
  private readonly ethicsGate: AskEthicsGate;
  private readonly logger: Logger;
  private readonly synthesizer: Synthesizer;
  private readonly rankSink: RankSignalSink | null;
  private readonly runRootDir: string;
  private readonly clock: () => Date;

  public constructor(deps: AskPipelineDependencies) {
    this.searchProvider = deps.searchProvider;
    this.fetcher = deps.fetcher;
    this.extractor = deps.extractor;
    this.cache = deps.cache;
    this.ethicsGate = deps.ethicsGate;
    this.logger = deps.logger;
    this.synthesizer = deps.synthesizer;
    this.rankSink = deps.rankSink ?? null;
    this.runRootDir = deps.runRootDir ?? join(dataDir(), 'runs');
    this.clock = deps.clock ?? (() => new Date());
  }

  public async run(query: AskQuery): Promise<AskRunResult> {
    const runId = randomUUID();
    const taskId = generateUlid();
    const startedAt = this.clock().toISOString();
    const runDir = join(this.runRootDir, runId);
    const events = new JsonlEventBus(join(runDir, 'events.jsonl'));

    const emit = (event: TaskEvent): void => {
      events.publish(event);
    };

    let status: 'ok' | 'partial' | 'failed' = 'failed';
    let failureClass: FailureClass | null = null;

    await this.prepareRunDir(runDir);
    emit({ kind: 'task_started', task_id: taskId, at: this.clock().toISOString() });

    const normalizedQuery = query.normalized.trim() || query.raw.trim();
    const utcDay = utcDayFrom(startedAt);
    const providerName = query.searchProvider ?? this.searchProvider.name;
    const key = cacheKey(normalizedQuery, providerName, utcDay);

    const controller = new AbortController();
    const budgetTimer = setTimeout(() => controller.abort(), query.pipelineBudgetMs);
    if (typeof budgetTimer.unref === 'function') {
      budgetTimer.unref();
    }

    try {
      if (!query.noCache) {
        const cached = await this.cache.get(key);
        if (cached) {
          status = cached.notices.length > 0 ? 'partial' : 'ok';
          const artifacts = await this.persist(
            runDir,
            taskId,
            query,
            providerName,
            startedAt,
            status,
            cached,
          );
          emit({
            kind: 'task_completed',
            task_id: taskId,
            outputs_keys: ['brief'],
            at: this.clock().toISOString(),
          });
          return { brief: cached, artifacts };
        }
      }

      const { candidates, budgetExhausted: searchBudgetHit } = await this.search(
        normalizedQuery,
        query,
        taskId,
        emit,
        controller,
      );

      const processed = await Promise.all(
        candidates.map((result) =>
          this.processSearchResult(result, query, runDir, taskId, emit, controller.signal),
        ),
      );

      for (const entry of processed) {
        if (entry.failure !== null) {
          safeRecordRankSignal(this.rankSink, {
            domain: entry.failure.host,
            delta: -1,
            reason: rankReasonForFailureStage(entry.failure.stage),
          });
        }
      }

      const budgetExhausted = searchBudgetHit || controller.signal.aborted;

      const docs = processed.flatMap((entry) => (entry.doc !== null ? [entry.doc] : []));
      const failures = processed.flatMap((entry) =>
        entry.failure !== null ? [entry.failure] : [],
      );

      const outcome = await this.synthesizer.synthesize(
        { query: normalizedQuery, docs, failures },
        {
          strategy: query.noLlm ? 'deterministic' : 'auto',
          // The Brief always carries the full document; the terminal `--detail`
          // flag chooses what to *display*, so synthesis fills every block.
          detail: 'full',
          length: query.length,
          scope: 'public',
          taskId,
          runId,
          searchProvider: providerName,
          ...(query.personalization ? { personalization: query.personalization } : {}),
        },
      );

      if (!outcome.isOk) {
        throw new AskPipelineError(outcome.error.message, 'unexpected', {
          runDir,
          cause: outcome.error,
        });
      }

      let brief = outcome.value.brief;
      if (candidates.length === 0 && !budgetExhausted) {
        brief = appendNotice(brief, {
          source: 'search',
          reason: 'the search provider returned no results',
          kind: 'other',
        });
      }
      if (budgetExhausted) {
        brief = appendNotice(brief, {
          source: 'pipeline',
          reason: 'time budget exhausted before all sources were processed',
          kind: 'budget_exhausted',
        });
      }

      emit({
        kind: 'synthesis_completed',
        task_id: taskId,
        at: this.clock().toISOString(),
        strategy: outcome.value.strategyUsed,
        sources_in: docs.length,
        sources_used: brief.sources.length,
        coverage: brief.metadata.coverage,
        citation_verdict: {
          claims_checked: outcome.value.verdict.claimsChecked,
          flagged: outcome.value.verdict.flagged,
          stripped: outcome.value.verdict.stripped,
        },
      });

      // Cache only Briefs that carry real sources, so a transient all-failed or
      // budget-truncated run can be retried within the day.
      if (!query.noCache && brief.sources.length > 0) {
        await this.cache.put(key, brief, {
          query: normalizedQuery,
          searchProvider: providerName,
          utcDay,
        });
      }

      status = brief.notices.length > 0 ? 'partial' : 'ok';
      const artifacts = await this.persist(
        runDir,
        taskId,
        query,
        providerName,
        startedAt,
        status,
        brief,
      );

      emit({
        kind: 'task_completed',
        task_id: taskId,
        outputs_keys: ['brief'],
        at: this.clock().toISOString(),
      });

      return { brief, artifacts };
    } catch (error) {
      failureClass = classifyFailure(error);
      const reportPath = join(runDir, 'report.md');
      emit({
        kind: 'task_failed',
        task_id: taskId,
        failure_class: failureClass,
        report_path: reportPath,
        at: this.clock().toISOString(),
      });
      await this.writeManifest(runDir, taskId, query, providerName, startedAt, 'failed');
      await writeFile(reportPath, this.failureReport(query, error), 'utf8');
      throw toAskPipelineError(error, failureClass, runDir);
    } finally {
      clearTimeout(budgetTimer);
      await events.flush();
      await events.close();
      this.logger.info({ runId, status, failureClass }, 'ask pipeline finished');
    }
  }

  /** Runs search, honoring the budget: an abort mid-search yields empty candidates. */
  private async search(
    normalizedQuery: string,
    query: AskQuery,
    taskId: string,
    emit: (event: TaskEvent) => void,
    controller: AbortController,
  ): Promise<{ candidates: readonly SearchResult[]; budgetExhausted: boolean }> {
    emit({
      kind: 'step_started',
      task_id: taskId,
      step_id: 'search',
      step_type: 'extract',
      at: this.clock().toISOString(),
    });

    let searchResults: readonly SearchResult[] = [];
    let budgetExhausted = false;
    try {
      searchResults = await this.searchProvider.search(normalizedQuery, {
        limit: Math.max(1, query.limit) + 2,
        signal: controller.signal,
      });
      for (const result of searchResults) {
        const domain = domainFromUrl(result.url);
        if (domain !== null) {
          safeRecordRankSignal(this.rankSink, {
            domain,
            delta: 1,
            reason: 'search_result',
          });
        }
      }
    } catch (error) {
      // A budget abort during search is not a hard failure — degrade to a
      // partial (empty) Brief; any other search error propagates.
      if (controller.signal.aborted) {
        budgetExhausted = true;
      } else {
        throw error;
      }
    }

    emit({
      kind: 'step_completed',
      task_id: taskId,
      step_id: 'search',
      capture_keys: [],
      at: this.clock().toISOString(),
    });

    const budgetCalls = query.budgetCalls ?? query.limit;
    const candidates = searchResults.slice(
      0,
      Math.max(1, Math.min(searchResults.length, Math.max(query.limit, budgetCalls) + 2)),
    );

    return { candidates, budgetExhausted };
  }

  private async processSearchResult(
    result: SearchResult,
    query: AskQuery,
    runDir: string,
    taskId: string,
    emit: (event: TaskEvent) => void,
    signal: AbortSignal,
  ): Promise<ProcessedSource> {
    const stepId = `source-${result.rank}`;
    emit({
      kind: 'step_started',
      task_id: taskId,
      step_id: stepId,
      step_type: 'extract',
      at: this.clock().toISOString(),
    });

    try {
      return await processSource(
        { ethicsGate: this.ethicsGate, fetcher: this.fetcher, extractor: this.extractor },
        result,
        {
          perFetchTimeoutMs: query.perFetchTimeoutMs,
          signal,
          onFetchedHtml: (url, html) => this.writeFetchedHtml(runDir, url, html),
          onTimeout: () =>
            emit({
              kind: 'step_retry',
              task_id: taskId,
              step_id: stepId,
              attempt: 1,
              reason: 'network_error',
              at: this.clock().toISOString(),
            }),
        },
      );
    } finally {
      emit({
        kind: 'step_completed',
        task_id: taskId,
        step_id: stepId,
        capture_keys: [`source:${result.rank}`],
        at: this.clock().toISOString(),
      });
    }
  }

  /** Writes the manifest + Brief artifacts; artifact failures degrade to null. */
  private async persist(
    runDir: string,
    taskId: string,
    query: AskQuery,
    providerName: string,
    startedAt: string,
    status: 'ok' | 'partial' | 'failed',
    brief: Brief,
  ): Promise<BriefArtifactPaths | null> {
    await this.writeManifest(runDir, taskId, query, providerName, startedAt, status);

    const result = await writeBriefArtifacts(runDir, brief);
    if (!result.isOk) {
      this.logger.warn(
        { runDir, error: result.error.message },
        'brief artifacts not written; run still succeeded',
      );
      return null;
    }
    return result.value;
  }

  private async writeFetchedHtml(runDir: string, url: string, html: string): Promise<void> {
    const dir = join(runDir, 'fetched');
    await mkdir(dir, { recursive: true });
    const fileName = `${createHash('sha256').update(url).digest('hex')}.html.txt`;
    await writeFile(join(dir, fileName), html, 'utf8');
  }

  private async writeManifest(
    runDir: string,
    taskId: string,
    query: AskQuery,
    providerName: string,
    startedAt: string,
    status: 'ok' | 'partial' | 'failed',
  ): Promise<void> {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify(
        {
          task_id: taskId,
          type: 'ask',
          query: query.raw,
          search_provider: providerName,
          started_at: startedAt,
          finished_at: this.clock().toISOString(),
          status,
          scope_summary: 'public',
          outputs: status === 'failed' ? [] : ['brief.json', 'brief.md', 'brief.html'],
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private failureReport(query: AskQuery, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `# Ask failed\n\nQuery: ${query.raw}\n\nReason: ${reason}\n`;
  }

  private async prepareRunDir(runDir: string): Promise<void> {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'fetched'), { recursive: true });
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');
  }
}

function classifyFailure(error: unknown): FailureClass {
  if (error instanceof AskPipelineError) {
    return error.failureClass;
  }
  if (error instanceof FetchError) {
    return error.context.kind === 'timeout' ? 'navigation_timeout' : 'network_error';
  }
  if (error instanceof SearchProviderError) {
    return error.context.statusCode === 429 ? 'rate_limited' : 'network_error';
  }
  return 'unexpected';
}

function toAskPipelineError(
  error: unknown,
  failureClass: FailureClass,
  runDir: string,
): AskPipelineError {
  if (error instanceof AskPipelineError) {
    return error;
  }
  return new AskPipelineError(
    error instanceof Error ? error.message : 'ask pipeline failed',
    failureClass,
    {
      runDir,
      cause: error,
    },
  );
}
