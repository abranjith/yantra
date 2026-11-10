import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief, FailureClass, TaskEvent } from '@yantra/protocol';
import { appendNotice, generateUlid } from '@yantra/protocol';

import { writeBriefArtifacts, type BriefArtifactPaths } from '../brief/write-artifacts.js';
import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import {
  domainFromUrl,
  rankReasonForFailureStage,
  safeRecordRankSignal,
} from '../ranking/recording.js';
import type { RankSignalSink } from '../ranking/types.js';
import { writeExecutionReceipt } from '../receipt/execution-receipt.js';
import { openTaskEventBus } from '../run-events/mirroring-event-bus.js';
import { asToken, boundedQuery, sourceFetchedEvent } from '../run-events/phase-fields.js';
import { recordReceiptWritten } from '../run-events/receipt-written.js';
import { abandonOwnedStream, emitArtifactSaved, runOutcomeEvent } from '../run-events/run-facts.js';
import { RunEventStream } from '../run-events/stream.js';
import type { DeferredBrowserOwnershipRecorder } from '../run-ownership/browser-ownership-recorder.js';
import {
  RunOwnershipSession,
  type RunOwnershipSessionOptions,
} from '../run-ownership/ownership-session.js';
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
  /** Opens the run's ownership session (FEAT-064); tests inject a fake socket. */
  readonly openOwnership?: (options: RunOwnershipSessionOptions) => Promise<RunOwnershipSession>;
  /**
   * The recorder the caller's browser provider was built with; the run binds
   * it to its ownership session, so every browser it launches is recorded.
   */
  readonly ownershipRecorder?: DeferredBrowserOwnershipRecorder;
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
  private readonly ownershipRecorder: DeferredBrowserOwnershipRecorder | undefined;
  private readonly openOwnership: (
    options: RunOwnershipSessionOptions,
  ) => Promise<RunOwnershipSession>;
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
    this.ownershipRecorder = deps.ownershipRecorder;
    this.openOwnership = deps.openOwnership ?? ((options) => RunOwnershipSession.open(options));
    this.clock = deps.clock ?? (() => new Date());
  }

  public async run(query: AskQuery): Promise<AskRunResult> {
    const runId = randomUUID();
    const taskId = generateUlid();
    const startedAt = this.clock().toISOString();
    const runDir = join(this.runRootDir, runId);
    // FEAT-063: the run's event stream. A caller-supplied one is already
    // subscribed by its renderer; otherwise this run owns one.
    const ownsRunEvents = query.runEvents === undefined;
    const runEvents = query.runEvents ?? new RunEventStream({ logger: this.logger });

    let status: 'ok' | 'partial' | 'failed' = 'failed';
    let failureClass: FailureClass | null = null;

    await this.prepareRunDir(runDir);
    // FEAT-064: own the run directory (lease and run socket) before any manifest.
    const ownership = await this.openOwnership({
      runDir,
      runId,
      origin: query.receipt?.invoked_by ?? 'terminal',
      executionClass: 'run',
      command: ['ask'],
      logger: this.logger,
    });
    this.ownershipRecorder?.bind(ownership.recorder);
    try {
      await this.openRunEvents(runEvents, runDir, runId, taskId, query, startedAt);
    } catch (error) {
      await ownership.finish();
      throw error;
    }
    ownership.attachEvents(runEvents);
    const events = openTaskEventBus(runDir, runEvents);
    const emit = (event: TaskEvent): void => {
      events.publish(event);
    };
    emit({ kind: 'task_started', task_id: taskId, at: this.clock().toISOString() });

    const normalizedQuery = query.normalized.trim() || query.raw.trim();
    const utcDay = utcDayFrom(startedAt);
    const providerName = query.searchProvider ?? this.searchProvider.name;
    const key = cacheKey(normalizedQuery, providerName, utcDay);
    const phaseQuery = boundedQuery(normalizedQuery);
    let threw = false;

    const controller = new AbortController();
    const budgetTimer = setTimeout(() => controller.abort(), query.pipelineBudgetMs);
    if (typeof budgetTimer.unref === 'function') {
      budgetTimer.unref();
    }

    try {
      if (query.receipt) {
        const written = await writeExecutionReceipt(runDir, query.receipt);
        await recordReceiptWritten(runEvents, written.path);
        this.logger.info(
          {
            event: 'settings_receipt_written',
            path: written.path,
            setting_count: written.receipt.settings.length,
          },
          'settings_receipt_written',
        );
      }
      if (!query.noCache) {
        const cached = await this.cache.get(key);
        if (cached) {
          runEvents.emit({
            kind: 'search_completed',
            hop_index: null,
            provider: asToken(providerName),
            query: phaseQuery,
            result_count: cached.sources.length,
            cached: true,
            at: this.clock().toISOString(),
          });
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
          this.recordArtifacts(runEvents, runDir, artifacts);
          emit({
            kind: 'task_completed',
            task_id: taskId,
            outputs_keys: ['brief'],
            at: this.clock().toISOString(),
          });
          this.recordOutcome(runEvents, runId, status);
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
      runEvents.emit({
        kind: 'search_completed',
        hop_index: null,
        provider: asToken(providerName),
        query: phaseQuery,
        result_count: candidates.length,
        cached: false,
        at: this.clock().toISOString(),
      });

      const processed = await Promise.all(
        candidates.map((result, index) =>
          this.processSearchResult(result, query, runDir, taskId, emit, controller.signal, {
            runEvents,
            sourceIndex: index + 1,
          }),
        ),
      );

      for (const entry of processed) {
        const reason =
          entry.failure === null ? null : rankReasonForFailureStage(entry.failure.stage);
        if (entry.failure !== null && reason !== null) {
          safeRecordRankSignal(this.rankSink, { domain: entry.failure.host, delta: -1, reason });
        }
      }

      const budgetExhausted = searchBudgetHit || controller.signal.aborted;

      const docs = processed.flatMap((entry) => (entry.doc !== null ? [entry.doc] : []));
      const failures = processed.flatMap((entry) =>
        entry.failure !== null ? [entry.failure] : [],
      );
      runEvents.emit({
        kind: 'extract_completed',
        hop_index: null,
        extracted: docs.length,
        failed: failures.length,
        at: this.clock().toISOString(),
      });
      runEvents.emit({
        kind: 'synthesize_started',
        strategy: query.noLlm ? 'deterministic' : 'llm',
        sources_in: docs.length,
        at: this.clock().toISOString(),
      });

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
      this.recordArtifacts(runEvents, runDir, artifacts);

      emit({
        kind: 'task_completed',
        task_id: taskId,
        outputs_keys: ['brief'],
        at: this.clock().toISOString(),
      });
      this.recordOutcome(runEvents, runId, status);

      return { brief, artifacts };
    } catch (error) {
      threw = true;
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
      const failure = toAskPipelineError(error, failureClass, runDir);
      await events.flush();
      abandonOwnedStream(runEvents, ownsRunEvents, runId, error);
      throw failure;
    } finally {
      clearTimeout(budgetTimer);
      await events.flush();
      await events.close();
      if (!threw) runEvents.close();
      // After the final manifest and the terminal event (FEAT-064 order).
      await ownership.finish();
      this.logger.info({ runId, status, failureClass }, 'ask pipeline finished');
    }
  }

  /**
   * Opens the run's event log. One that cannot be opened is an environment
   * failure before the run proceeds: the run is recorded as failed (manifest
   * and report) and the typed error is rethrown.
   */
  private async openRunEvents(
    runEvents: RunEventStream,
    runDir: string,
    runId: string,
    taskId: string,
    query: AskQuery,
    startedAt: string,
  ): Promise<void> {
    try {
      runEvents.open({ runDir, runId, logger: this.logger });
    } catch (error) {
      const providerName = query.searchProvider ?? this.searchProvider.name;
      await this.writeManifest(runDir, taskId, query, providerName, startedAt, 'failed');
      await writeFile(join(runDir, 'report.md'), this.failureReport(query, error), 'utf8');
      throw error;
    }
  }

  /** Records the persisted Brief files. */
  private recordArtifacts(
    runEvents: RunEventStream,
    runDir: string,
    artifacts: BriefArtifactPaths | null,
  ): void {
    if (artifacts === null) return;
    const at = this.clock().toISOString();
    for (const path of [artifacts.jsonPath, artifacts.mdPath, artifacts.htmlPath]) {
      emitArtifactSaved(runEvents, runDir, path, 'brief', at);
    }
  }

  /**
   * Records the run's one outcome and closes the stream. A deterministic
   * `ask` that saved a Brief exits 0: `fulfilled` with no notices, `partial`
   * when the Brief carries notices (a source failed, the budget ran out).
   */
  private recordOutcome(
    runEvents: RunEventStream,
    runId: string,
    status: 'ok' | 'partial' | 'failed',
  ): void {
    runEvents.emit(
      runOutcomeEvent({
        runId,
        taskOutcome: status === 'ok' ? 'fulfilled' : 'partial',
        terminationReason: null,
        stopDetail: null,
        exitCode: 0,
        failureClass: null,
        at: this.clock().toISOString(),
      }),
    );
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
    phase: { readonly runEvents: RunEventStream; readonly sourceIndex: number },
  ): Promise<ProcessedSource> {
    const stepId = `source-${result.rank}`;
    const startedMs = this.clock().getTime();
    let processed: ProcessedSource | null = null;
    emit({
      kind: 'step_started',
      task_id: taskId,
      step_id: stepId,
      step_type: 'extract',
      at: this.clock().toISOString(),
    });

    try {
      processed = await processSource(
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
      return processed;
    } finally {
      emit({
        kind: 'step_completed',
        task_id: taskId,
        step_id: stepId,
        capture_keys: [`source:${result.rank}`],
        at: this.clock().toISOString(),
      });
      phase.runEvents.emit(
        sourceFetchedEvent(result.url, processed, {
          hopIndex: null,
          sourceIndex: phase.sourceIndex,
          durationMs: Math.max(0, this.clock().getTime() - startedMs),
          at: this.clock().toISOString(),
        }),
      );
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
