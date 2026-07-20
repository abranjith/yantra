/**
 * ResearchLoop — the bounded multi-hop controller (TASK-001).
 *
 * Orchestrates hops over injected stage dependencies:
 * `search → fetch/extract → pool → (interim synthesis for gap analysis) →
 * follow-up queries → repeat`, then one final long-form synthesis over the
 * whole {@link SourcePool}. At `--depth 1` this reduces to a single hop —
 * functionally `ask` with a larger source budget, the correctness baseline.
 *
 * ### Termination conditions (any → stop, priority order)
 *
 * | Priority | Condition                    | `terminationReason`     |
 * | -------- | ---------------------------- | ----------------------- |
 * | 1        | wall-clock / source / LLM cap | budget dimension        |
 * | 2        | coverage ≥ target             | `coverage_met`          |
 * | 3        | `maxHops` reached             | `max_hops`              |
 * | 4        | no novel follow-up queries    | `no_novel_queries`      |
 *
 * A budget stop is a **success with notice**, never a failure: the loop emits
 * an honest partial Brief carrying a `budget_exhausted` notice. Per-source
 * failures isolate to notices (reusing {@link processSource}); a search
 * provider error mid-hop degrades that query to zero results and continues.
 * The wall-clock is enforced by {@link BudgetTracker}'s injectable clock —
 * proven with a fake clock and **zero real sleeps** — plus a real abort timer
 * armed only under the default wall-clock so a genuinely hung fetch is cut off.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief, BriefNotice, FailureClass, TaskEvent } from '@yantra/protocol';
import { appendNotice, generateUlid } from '@yantra/protocol';

import { writeBriefArtifacts, type BriefArtifactPaths } from '../brief/write-artifacts.js';
import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import { JsonlEventBus } from '../executor/event-bus.js';
import type { AskEthicsGate } from '../extraction/ethics-adapter.js';
import type { ContentFetcher } from '../extraction/fetcher.js';
import type { Extractor } from '../extraction/readability.js';
import { SearchProviderError } from '../extraction/search/errors.js';
import type { SearchProvider } from '../extraction/search/registry.js';
import { processSource } from '../extraction/source-processor.js';
import type { SearchResult } from '../extraction/types.js';
import {
  domainFromUrl,
  rankReasonForFailureStage,
  safeRecordRankSignal,
} from '../ranking/recording.js';
import type { RankSignalSink } from '../ranking/types.js';
import { DeterministicSynthesizer } from '../synthesis/deterministic.js';
import type { SourceFailure, Synthesizer } from '../synthesis/types.js';

import { BudgetTracker } from './budget.js';
import { CoverageTracker } from './coverage.js';
import { type FollowUpQueryGenerator } from './query-gen.js';
import { normalizeUrl, SourcePool } from './source-pool.js';
import type {
  BudgetExhausted,
  ResearchHop,
  ResearchOptions,
  ResearchRunResult,
  ResearchState,
  TerminationReason,
} from './types.js';

/** A run-aborting research failure (only truly unexpected errors reach here). */
export class ResearchLoopError extends Error {
  public override readonly name = 'ResearchLoopError';

  public constructor(
    message: string,
    public readonly failureClass: FailureClass,
    public readonly context: { readonly runDir: string; readonly cause?: unknown },
  ) {
    super(message);
  }
}

/** Injected stage dependencies for the loop (all mockable). */
export interface ResearchLoopDependencies {
  /** Resolved search provider (FEAT-016 registry / fallback chain). */
  readonly searchProvider: SearchProvider;
  /** Content fetcher (http + browser fallback). */
  readonly fetcher: ContentFetcher;
  /** Readability extractor. */
  readonly extractor: Extractor;
  /** Ethics gate applied to every fetch (non-bypassable). */
  readonly ethicsGate: AskEthicsGate;
  /** Strategy for the final long-form synthesis (deterministic or LLM). */
  readonly synthesizer: Synthesizer;
  /** Follow-up query generator (LLM + deterministic). */
  readonly queryGen: FollowUpQueryGenerator;
  /** Logger. */
  readonly logger: Logger;
  /** Optional observation-only domain ranking sink. */
  readonly rankSink?: RankSignalSink;
  /**
   * Synthesizer used for cheap per-hop interim gap analysis. Defaults to a
   * fresh {@link DeterministicSynthesizer} so gap analysis never spends LLM
   * budget — only the final document may use the LLM strategy.
   */
  readonly interimSynthesizer?: Synthesizer;
  /** Run-directory root; defaults to `<dataDir>/runs`. */
  readonly runRootDir?: string;
  /** Wall-clock timestamp source for artifacts/freshness; defaults to `Date`. */
  readonly clock?: () => Date;
  /** Monotonic ms clock for the budget tracker; defaults to `Date.now`. */
  readonly budgetNow?: () => number;
}

/** Internal per-hop tally returned by {@link ResearchLoop.runHop}. */
interface HopOutcome {
  readonly resultsCount: number;
  readonly docsFetched: number;
  readonly docsKept: number;
  readonly budgetStop: BudgetExhausted | null;
}

/**
 * The bounded research controller. One {@link ResearchLoop.run} drives a whole
 * `research` invocation end to end.
 */
export class ResearchLoop {
  private readonly deps: ResearchLoopDependencies;
  private readonly interimSynthesizer: Synthesizer;
  private readonly runRootDir: string;
  private readonly clock: () => Date;
  private readonly budgetNow: () => number;
  private readonly usingRealClock: boolean;

  public constructor(deps: ResearchLoopDependencies) {
    this.deps = deps;
    this.interimSynthesizer =
      deps.interimSynthesizer ??
      new DeterministicSynthesizer(deps.clock ? { clock: deps.clock } : {});
    this.runRootDir = deps.runRootDir ?? join(dataDir(), 'runs');
    this.clock = deps.clock ?? (() => new Date());
    this.budgetNow = deps.budgetNow ?? Date.now;
    this.usingRealClock = deps.budgetNow === undefined;
  }

  /**
   * Runs the bounded research loop for `options`.
   *
   * @param options - Topic, budgets, and synthesis knobs.
   * @returns The long-form Brief, its artifacts, the hop trace, and why it
   *   stopped. Only truly unexpected errors throw {@link ResearchLoopError}.
   */
  public async run(options: ResearchOptions): Promise<ResearchRunResult> {
    const runId = randomUUID();
    const taskId = generateUlid();
    const startedAt = this.clock().toISOString();
    const runDir = join(this.runRootDir, runId);
    const events = new JsonlEventBus(join(runDir, 'events.jsonl'));
    const emit = (event: TaskEvent): void => events.publish(event);

    const budget = new BudgetTracker(options.budget, { now: this.budgetNow });
    const pool = new SourcePool({ maxSources: options.budget.maxSources });
    const coverage = new CoverageTracker();
    const failures: SourceFailure[] = [];
    const extraNotices: BriefNotice[] = [];
    const hops: ResearchHop[] = [];
    const issuedQueries: string[] = [];

    const controller = new AbortController();
    const abortTimer = this.usingRealClock
      ? setTimeout(() => controller.abort(), options.budget.maxWallClockMs)
      : null;
    if (abortTimer && typeof abortTimer.unref === 'function') {
      abortTimer.unref();
    }

    let terminationReason: TerminationReason = 'max_hops';
    let budgetStop: BudgetExhausted | null = null;
    let nextQueries: string[] = [options.topic.trim() || options.topic];
    let prevCoverage = 0;

    await this.prepareRunDir(runDir);
    emit({ kind: 'task_started', task_id: taskId, at: this.clock().toISOString() });

    try {
      while (true) {
        const checkpoint = budget.checkpoint();
        if (!checkpoint.isOk) {
          budgetStop = checkpoint.error;
          terminationReason = checkpoint.error.dimension;
          break;
        }
        if (!budget.canStartHop()) {
          terminationReason = 'max_hops';
          break;
        }
        if (nextQueries.length === 0) {
          terminationReason = 'no_novel_queries';
          break;
        }

        budget.recordHop();
        const hopIndex = budget.snapshot().hopsUsed;
        const hopQueries = nextQueries;
        issuedQueries.push(...hopQueries);

        const hopOutcome = await this.runHop(
          hopQueries,
          pool,
          failures,
          extraNotices,
          options,
          budget,
          controller.signal,
          runDir,
        );
        if (hopOutcome.budgetStop) {
          budgetStop = hopOutcome.budgetStop;
          terminationReason = hopOutcome.budgetStop.dimension;
        }

        // Interim (deterministic) synthesis drives coverage seeding + gaps.
        const interim = await this.interimSynthesizer.synthesize(
          pool.toSynthesisInput(options.topic, failures),
          this.synthOptions(options, taskId, runId, 'standard', 'medium'),
        );
        const interimBrief = interim.isOk ? interim.value.brief : null;

        if (interimBrief && !coverage.isSeeded()) {
          coverage.seed(interimBrief, pool.docs());
        } else {
          coverage.update(pool.docs());
        }

        const coverageScore = coverage.score();
        const gaps = coverage.gaps();
        hops.push({
          index: hopIndex,
          queries: hopQueries,
          resultsCount: hopOutcome.resultsCount,
          docsFetched: hopOutcome.docsFetched,
          docsKept: hopOutcome.docsKept,
          gapsIdentified: gaps,
          coverage: coverageScore,
        });

        emit({
          kind: 'research_hop_completed',
          task_id: taskId,
          at: this.clock().toISOString(),
          hop_index: hopIndex,
          queries: [...hopQueries],
          docs_fetched: hopOutcome.docsFetched,
          docs_kept: hopOutcome.docsKept,
          coverage: coverageScore,
          coverage_delta: coverageScore - prevCoverage,
        });
        prevCoverage = coverageScore;

        await this.writeResearchState(
          runDir,
          hopIndex,
          this.snapshotState(options.topic, hops, pool, coverage, budget, null),
        );

        if (budgetStop) {
          break;
        }
        if (coverageScore >= options.coverageTarget) {
          terminationReason = 'coverage_met';
          break;
        }
        if (!budget.canStartHop()) {
          terminationReason = 'max_hops';
          break;
        }

        // Follow-up query generation for the next hop.
        const generated = await this.deps.queryGen.generate({
          topic: options.topic,
          gaps,
          interimOverview: interimBrief?.overview ?? '',
          issuedQueries,
          scope: options.scope,
          host: 'research',
        });
        if (generated.usedLlm) {
          budget.recordLlmCall();
        }
        nextQueries = [...generated.queries];
      }

      const brief = await this.finalize(
        options,
        pool,
        coverage,
        failures,
        extraNotices,
        budgetStop,
        taskId,
        runId,
        emit,
        runDir,
        startedAt,
      );

      await this.writeResearchState(
        runDir,
        hops.length,
        this.snapshotState(options.topic, hops, pool, coverage, budget, terminationReason),
      );
      emit({
        kind: 'task_completed',
        task_id: taskId,
        outputs_keys: ['brief'],
        at: this.clock().toISOString(),
      });

      return { brief: brief.brief, artifacts: brief.artifacts, hops, terminationReason };
    } catch (error) {
      const failureClass = classifyFailure(error);
      const reportPath = join(runDir, 'report.md');
      emit({
        kind: 'task_failed',
        task_id: taskId,
        failure_class: failureClass,
        report_path: reportPath,
        at: this.clock().toISOString(),
      });
      await this.writeManifest(runDir, taskId, options, startedAt, 'failed');
      await writeFile(reportPath, this.failureReport(options, error), 'utf8').catch(
        () => undefined,
      );
      throw toResearchLoopError(error, failureClass, runDir);
    } finally {
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      await events.flush();
      await events.close();
      this.deps.logger.info({ runId, terminationReason }, 'research loop finished');
    }
  }

  /** Runs one hop: search the queries, then fetch/extract/pool sequentially. */
  private async runHop(
    queries: readonly string[],
    pool: SourcePool,
    failures: SourceFailure[],
    extraNotices: BriefNotice[],
    options: ResearchOptions,
    budget: BudgetTracker,
    signal: AbortSignal,
    runDir: string,
  ): Promise<HopOutcome> {
    const results = await this.search(queries, options, signal, extraNotices);

    let docsFetched = 0;
    let docsKept = 0;
    let budgetStop: BudgetExhausted | null = null;

    for (const result of results) {
      if (pool.isFull()) {
        break;
      }
      const checkpoint = budget.checkpoint();
      if (!checkpoint.isOk) {
        budgetStop = checkpoint.error;
        break;
      }

      const processed = await processSource(
        {
          ethicsGate: this.deps.ethicsGate,
          fetcher: this.deps.fetcher,
          extractor: this.deps.extractor,
        },
        result,
        {
          perFetchTimeoutMs: options.perFetchTimeoutMs,
          signal,
          onFetchedHtml: (url, html) => this.writeFetchedHtml(runDir, url, html),
        },
      );

      if (processed.doc) {
        docsFetched += 1;
        const added = pool.add(processed.doc, result.rank);
        if (added.kept) {
          docsKept += 1;
          budget.recordSources(1);
        }
      } else if (processed.failure) {
        failures.push(processed.failure);
        safeRecordRankSignal(this.deps.rankSink, {
          domain: processed.failure.host,
          delta: -1,
          reason: rankReasonForFailureStage(processed.failure.stage),
        });
      }
    }

    return { resultsCount: results.length, docsFetched, docsKept, budgetStop };
  }

  /**
   * Searches every query this hop, deduplicating hits by normalized URL. A
   * provider error on one query degrades to zero results for that query (a
   * notice) and never aborts the hop.
   */
  private async search(
    queries: readonly string[],
    options: ResearchOptions,
    signal: AbortSignal,
    extraNotices: BriefNotice[],
  ): Promise<readonly SearchResult[]> {
    const seen = new Set<string>();
    const combined: SearchResult[] = [];

    for (const query of queries) {
      let results: readonly SearchResult[];
      try {
        results = await this.deps.searchProvider.search(query, {
          limit: Math.max(1, options.perQueryLimit),
          signal,
        });
        for (const result of results) {
          const domain = domainFromUrl(result.url);
          if (domain !== null) {
            safeRecordRankSignal(this.deps.rankSink, {
              domain,
              delta: 1,
              reason: 'search_result',
            });
          }
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        extraNotices.push({
          source: 'search',
          reason: `query "${query}" failed: ${error instanceof Error ? error.message : 'search error'}`,
          kind: 'other',
        });
        continue;
      }

      for (const result of results) {
        const identity = normalizeUrl(result.url);
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        combined.push(result);
      }
    }

    return combined;
  }

  /** Final long-form synthesis + notices + artifact persistence. */
  private async finalize(
    options: ResearchOptions,
    pool: SourcePool,
    coverage: CoverageTracker,
    failures: SourceFailure[],
    extraNotices: readonly BriefNotice[],
    budgetStop: BudgetExhausted | null,
    taskId: string,
    runId: string,
    emit: (event: TaskEvent) => void,
    runDir: string,
    startedAt: string,
  ): Promise<{ brief: Brief; artifacts: BriefArtifactPaths | null }> {
    const outcome = await this.deps.synthesizer.synthesize(
      pool.toSynthesisInput(options.topic, failures),
      {
        ...this.synthOptions(options, taskId, runId, 'full', options.length),
        hints: coverage.views().map((view) => view.label),
      },
    );
    if (!outcome.isOk) {
      throw new ResearchLoopError(outcome.error.message, 'unexpected', {
        runDir,
        cause: outcome.error,
      });
    }

    let brief = outcome.value.brief;
    for (const notice of extraNotices) {
      brief = appendNotice(brief, notice);
    }
    if (pool.size() === 0 && !budgetStop) {
      brief = appendNotice(brief, {
        source: 'search',
        reason: 'no sources could be retrieved for this topic',
        kind: 'other',
      });
    }
    if (budgetStop) {
      brief = appendNotice(brief, {
        source: 'pipeline',
        reason: `${budgetStop.message} before the topic was fully mapped`,
        kind: 'budget_exhausted',
      });
    }

    // The research coverage tracker is the authoritative coverage signal for a
    // multi-hop run — override the single-pass synthesizer's estimate.
    brief = {
      ...brief,
      metadata: { ...brief.metadata, coverage: pool.size() === 0 ? null : coverage.score() },
    };

    emit({
      kind: 'synthesis_completed',
      task_id: taskId,
      at: this.clock().toISOString(),
      strategy: outcome.value.strategyUsed,
      sources_in: pool.size(),
      sources_used: brief.sources.length,
      coverage: brief.metadata.coverage,
      citation_verdict: {
        claims_checked: outcome.value.verdict.claimsChecked,
        flagged: outcome.value.verdict.flagged,
        stripped: outcome.value.verdict.stripped,
      },
    });

    const status: 'ok' | 'partial' = brief.notices.length > 0 ? 'partial' : 'ok';
    await this.writeManifest(runDir, taskId, options, startedAt, status);
    const written = await writeBriefArtifacts(runDir, brief);
    const artifacts = written.isOk ? written.value : null;
    if (!written.isOk) {
      this.deps.logger.warn(
        { runDir, error: written.error.message },
        'brief artifacts not written; research run still succeeded',
      );
    }
    return { brief, artifacts };
  }

  private synthOptions(
    options: ResearchOptions,
    taskId: string,
    runId: string,
    detail: 'overview' | 'standard' | 'full',
    length: ResearchOptions['length'],
  ): Parameters<Synthesizer['synthesize']>[1] {
    return {
      strategy: options.noLlm ? 'deterministic' : 'auto',
      detail,
      length,
      scope: options.scope,
      taskId,
      runId,
      searchProvider: this.deps.searchProvider.name,
    };
  }

  private snapshotState(
    topic: string,
    hops: readonly ResearchHop[],
    pool: SourcePool,
    coverage: CoverageTracker,
    budget: BudgetTracker,
    terminationReason: TerminationReason | null,
  ): ResearchState {
    return {
      topic,
      hops: [...hops],
      pool: pool.docs().map((doc) => ({
        url: doc.url,
        host: doc.host,
        hash: createHash('sha256').update(doc.text).digest('hex').slice(0, 16),
      })),
      coverage: {
        score: coverage.score(),
        subtopics: coverage.views(),
      },
      budgetRemaining: budget.snapshot(),
      terminationReason,
    };
  }

  private async writeResearchState(
    runDir: string,
    hopIndex: number,
    state: ResearchState,
  ): Promise<void> {
    const finalPath = join(runDir, 'research-state.json');
    const tmpPath = `${finalPath}.${hopIndex}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmpPath, finalPath).catch(async () => {
      // Rename can race across hops on some filesystems; a direct write is an
      // acceptable fallback for a post-mortem artifact.
      await writeFile(finalPath, JSON.stringify(state, null, 2), 'utf8').catch(() => undefined);
    });
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
    options: ResearchOptions,
    startedAt: string,
    status: 'ok' | 'partial' | 'failed',
  ): Promise<void> {
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify(
        {
          task_id: taskId,
          type: 'research',
          topic: options.topic,
          search_provider: this.deps.searchProvider.name,
          started_at: startedAt,
          finished_at: this.clock().toISOString(),
          status,
          scope_summary: options.scope,
          outputs: status === 'failed' ? [] : ['brief.json', 'brief.md', 'brief.html'],
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private failureReport(options: ResearchOptions, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `# Research failed\n\nTopic: ${options.topic}\n\nReason: ${reason}\n`;
  }

  private async prepareRunDir(runDir: string): Promise<void> {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'fetched'), { recursive: true });
    await writeFile(join(runDir, 'agent.jsonl'), '', 'utf8');
    await writeFile(join(runDir, 'secrets.jsonl'), '', 'utf8');
  }
}

function classifyFailure(error: unknown): FailureClass {
  if (error instanceof ResearchLoopError) {
    return error.failureClass;
  }
  if (error instanceof SearchProviderError) {
    return error.context.statusCode === 429 ? 'rate_limited' : 'network_error';
  }
  return 'unexpected';
}

function toResearchLoopError(
  error: unknown,
  failureClass: FailureClass,
  runDir: string,
): ResearchLoopError {
  if (error instanceof ResearchLoopError) {
    return error;
  }
  return new ResearchLoopError(
    error instanceof Error ? error.message : 'research loop failed',
    failureClass,
    { runDir, cause: error },
  );
}
