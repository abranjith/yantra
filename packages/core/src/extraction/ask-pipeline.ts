import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FailureClass, TaskEvent } from '@yantra/protocol';

import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import { JsonlEventBus } from '../executor/event-bus.js';

import { cacheKey, utcDayFrom } from './cache-key.js';
import type { AskCache } from './cache.js';
import { renderJson, renderMarkdown } from './card.js';
import type { AskEthicsGate } from './ethics-adapter.js';
import { FetchError, type ContentFetcher } from './fetcher.js';
import type { Extractor } from './readability.js';
import { SearchProviderError } from './search/errors.js';
import type { SearchProvider } from './search/provider.js';
import type { Summarizer } from './summarizer.js';
import type { AskCard, AskQuery, SearchResult } from './types.js';

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
  readonly ruleBasedSummarizer: Summarizer;
  readonly llmSummarizer: Summarizer | null;
  readonly cache: AskCache;
  readonly ethicsGate: AskEthicsGate;
  readonly logger: Logger;
  readonly runRootDir?: string;
  readonly clock?: () => Date;
}

/**
 * Orchestrates the ask pipeline with deterministic fallback behavior.
 */
export class AskPipeline {
  private readonly searchProvider: SearchProvider;
  private readonly fetcher: ContentFetcher;
  private readonly extractor: Extractor;
  private readonly ruleBasedSummarizer: Summarizer;
  private readonly llmSummarizer: Summarizer | null;
  private readonly cache: AskCache;
  private readonly ethicsGate: AskEthicsGate;
  private readonly logger: Logger;
  private readonly runRootDir: string;
  private readonly clock: () => Date;

  public constructor(deps: AskPipelineDependencies) {
    this.searchProvider = deps.searchProvider;
    this.fetcher = deps.fetcher;
    this.extractor = deps.extractor;
    this.ruleBasedSummarizer = deps.ruleBasedSummarizer;
    this.llmSummarizer = deps.llmSummarizer;
    this.cache = deps.cache;
    this.ethicsGate = deps.ethicsGate;
    this.logger = deps.logger;
    this.runRootDir = deps.runRootDir ?? join(dataDir(), 'runs');
    this.clock = deps.clock ?? (() => new Date());
  }

  public async run(query: AskQuery): Promise<readonly AskCard[]> {
    const runId = randomUUID();
    const taskId = runId;
    const startedAt = this.clock().toISOString();
    const runDir = join(this.runRootDir, runId);
    const events = new JsonlEventBus(join(runDir, 'events.jsonl'));

    const emit = (event: TaskEvent): void => {
      events.publish(event);
    };

    let cards: AskCard[] = [];
    let status: 'ok' | 'partial' | 'failed' = 'failed';
    let failureClass: FailureClass | null = null;

    await this.prepareRunDir(runDir);

    emit({ kind: 'task_started', task_id: taskId, at: this.clock().toISOString() });

    const normalizedQuery = query.normalized.trim() || query.raw.trim();
    const utcDay = utcDayFrom(startedAt);
    const providerName = query.searchProvider ?? this.searchProvider.name;
    const key = cacheKey(normalizedQuery, providerName, utcDay);

    const pipelineController = new AbortController();
    const budgetTimer = setTimeout(() => pipelineController.abort(), query.pipelineBudgetMs);
    if (typeof budgetTimer.unref === 'function') {
      budgetTimer.unref();
    }

    try {
      if (!query.noCache) {
        const cachedCards = await this.cache.get(key);
        if (cachedCards) {
          cards = [...cachedCards];
          status = cards.some((card) => card.notice !== null) ? 'partial' : 'ok';
          emit({
            kind: 'task_completed',
            task_id: taskId,
            outputs_keys: ['cards'],
            at: this.clock().toISOString(),
          });
          await this.writeArtifacts({
            runDir,
            taskId,
            query,
            providerName,
            startedAt,
            status,
            cards,
          });
          return cards;
        }
      }

      emit({
        kind: 'step_started',
        task_id: taskId,
        step_id: 'search',
        step_type: 'extract',
        at: this.clock().toISOString(),
      });

      const searchResults = await this.searchProvider.search(normalizedQuery, {
        limit: Math.max(1, query.limit) + 2,
        signal: pipelineController.signal,
      });

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

      cards = (
        await Promise.all(
          candidates.map(async (result) =>
            this.processSearchResult(
              result,
              query,
              runDir,
              taskId,
              emit,
              pipelineController.signal,
            ),
          ),
        )
      )
        .sort((left, right) => {
          const leftScore = left.notice === null ? 0 : 1;
          const rightScore = right.notice === null ? 0 : 1;
          return leftScore - rightScore || left.rank - right.rank;
        })
        .slice(0, query.limit)
        .map((entry) => entry.card);

      if (cards.length === 0) {
        throw new AskPipelineError('Ask pipeline produced no cards.', 'unexpected', { runDir });
      }

      if (cards.every((card) => card.notice !== null)) {
        throw new AskPipelineError('All ask sources failed.', 'unexpected', { runDir });
      }

      if (!query.noCache) {
        await this.cache.put(key, cards, {
          query: normalizedQuery,
          searchProvider: providerName,
          utcDay,
        });
      }

      status = cards.some((card) => card.notice !== null) ? 'partial' : 'ok';
      emit({
        kind: 'task_completed',
        task_id: taskId,
        outputs_keys: ['cards'],
        at: this.clock().toISOString(),
      });
      await this.writeArtifacts({
        runDir,
        taskId,
        query,
        providerName,
        startedAt,
        status,
        cards,
      });
      return cards;
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

      await this.writeArtifacts({
        runDir,
        taskId,
        query,
        providerName,
        startedAt,
        status: 'failed',
        cards,
      });

      throw toAskPipelineError(error, failureClass, runDir);
    } finally {
      clearTimeout(budgetTimer);
      await events.flush();
      await events.close();
      this.logger.info({ runId, status, failureClass }, 'ask pipeline finished');
    }
  }

  private async processSearchResult(
    result: SearchResult,
    query: AskQuery,
    runDir: string,
    taskId: string,
    emit: (event: TaskEvent) => void,
    signal: AbortSignal,
  ): Promise<{ rank: number; notice: string | null; card: AskCard }> {
    const stepId = `source-${result.rank}`;
    emit({
      kind: 'step_started',
      task_id: taskId,
      step_id: stepId,
      step_type: 'extract',
      at: this.clock().toISOString(),
    });

    let card: AskCard;

    try {
      const ethics = await this.ethicsGate.checkUrl(result.url);
      if (!ethics.ok) {
        card = noticeCard(
          result,
          null,
          `this source was skipped: ${ethics.reason} - ${ethics.detail}`,
        );
        return { rank: result.rank, notice: card.notice, card };
      }

      const fetched = await this.fetcher.fetch(result.url, {
        timeoutMs: query.perFetchTimeoutMs,
        signal,
      });

      await this.writeFetchedHtml(runDir, result.url, fetched.html);

      const article = await this.extractor.extract(fetched);
      if (!article) {
        card = noticeCard(result, fetched.fetchedAt, 'could not extract a readable article');
        return { rank: result.rank, notice: card.notice, card };
      }

      const summarizer =
        query.noLlm || this.llmSummarizer === null ? this.ruleBasedSummarizer : this.llmSummarizer;
      const summary = await summarizer.summarize(article, query);

      card = {
        url: article.url,
        title: article.title ?? fallbackTitle(article.url),
        source: safeHost(article.url),
        fetchedAt: fetched.fetchedAt,
        publishedAt: article.publishedAt,
        summary: summary.summary,
        summaryKind: summary.kind,
        quotedSnippet: makeQuotedSnippet(
          article.contentText.length > 0 ? article.contentText : (article.excerpt ?? ''),
        ),
        tags: inferTags(query.normalized),
        notice: null,
      };

      return { rank: result.rank, notice: null, card };
    } catch (error) {
      if (error instanceof FetchError && error.context.kind === 'timeout') {
        emit({
          kind: 'step_retry',
          task_id: taskId,
          step_id: stepId,
          attempt: 1,
          reason: 'network_error',
          at: this.clock().toISOString(),
        });
      }

      const notice = buildNoticeFromError(error);
      card = noticeCard(result, null, notice);
      return { rank: result.rank, notice, card };
    } finally {
      emit({
        kind: 'step_completed',
        task_id: taskId,
        step_id: stepId,
        capture_keys: [`card:${result.rank}`],
        at: this.clock().toISOString(),
      });
    }
  }

  private async writeFetchedHtml(runDir: string, url: string, html: string): Promise<void> {
    const dir = join(runDir, 'fetched');
    await mkdir(dir, { recursive: true });
    const fileName = `${createHash('sha256').update(url).digest('hex')}.html.txt`;
    await writeFile(join(dir, fileName), html, 'utf8');
  }

  private async writeArtifacts(input: {
    readonly runDir: string;
    readonly taskId: string;
    readonly query: AskQuery;
    readonly providerName: string;
    readonly startedAt: string;
    readonly status: 'ok' | 'partial' | 'failed';
    readonly cards: readonly AskCard[];
  }): Promise<void> {
    const finishedAt = this.clock().toISOString();

    await mkdir(join(input.runDir, 'cards'), { recursive: true });

    await writeFile(
      join(input.runDir, 'manifest.json'),
      JSON.stringify(
        {
          task_id: input.taskId,
          type: 'ask',
          query: input.query.raw,
          search_provider: input.providerName,
          started_at: input.startedAt,
          finished_at: finishedAt,
          status: input.status,
          scope_summary: 'public',
        },
        null,
        2,
      ),
      'utf8',
    );

    await writeFile(
      join(input.runDir, 'outputs.json'),
      JSON.stringify(renderJson(input.cards), null, 2),
      'utf8',
    );

    await Promise.all(
      input.cards.map(async (card, index) => {
        await writeFile(
          join(input.runDir, 'cards', `${index}.json`),
          JSON.stringify(card, null, 2),
          'utf8',
        );
      }),
    );

    await writeFile(join(input.runDir, 'report.md'), renderMarkdown(input.cards), 'utf8');
  }

  private async prepareRunDir(runDir: string): Promise<void> {
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'cards'), { recursive: true });
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
    if (error.context.kind === 'timeout') {
      return 'navigation_timeout';
    }
    return 'network_error';
  }

  if (error instanceof SearchProviderError) {
    if (error.context.statusCode === 429) {
      return 'rate_limited';
    }
    return 'network_error';
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

function noticeCard(result: SearchResult, fetchedAt: string | null, notice: string): AskCard {
  return {
    url: result.url,
    title: result.title ?? fallbackTitle(result.url),
    source: safeHost(result.url),
    fetchedAt: fetchedAt ?? new Date().toISOString(),
    publishedAt: result.publishedAt,
    summary: '',
    summaryKind: 'fallback-lede',
    quotedSnippet: result.snippet?.slice(0, 280) ?? '',
    tags: [],
    notice,
  };
}

function makeQuotedSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 280) {
    return trimmed;
  }

  const sentenceBoundary = /^([\s\S]*?[.!?])\s/.exec(trimmed.slice(0, 280));
  if (sentenceBoundary?.[1]) {
    return sentenceBoundary[1].trim();
  }

  return trimmed.slice(0, 280).trim();
}

function inferTags(normalizedQuery: string): readonly string[] {
  return normalizedQuery
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1)
    .slice(0, 5);
}

function fallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function buildNoticeFromError(error: unknown): string {
  if (error instanceof FetchError) {
    if (error.context.kind === 'timeout') {
      return 'fetch timed out';
    }
    if (error.context.kind === 'http-status') {
      return `source returned HTTP ${error.context.statusCode ?? 'error'}`;
    }
    if (error.context.kind === 'too-large') {
      return 'source payload exceeded the size limit';
    }
    return 'fetch failed';
  }

  if (error instanceof AskPipelineError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'unexpected failure while processing source';
}
