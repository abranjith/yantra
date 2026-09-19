/**
 * Where the runtime log opens and closes in an agentic run's lifecycle.
 *
 * The ordering is the contract: browser, session and recorder tear down while
 * the destination is still open so their terminal lines persist; the log
 * closes next; the report is built last, so it can see whether the artifact
 * exists. Every terminal path — published, tool-failed, aborted, startup
 * failed, partial environment, teardown failed — has to close it exactly once,
 * because an unclosed destination is a leaked handle and a truncated artifact.
 *
 * These live beside `orchestrator.spec.ts` rather than inside it because they
 * need their own environment factory, and because the thing under test is the
 * lifecycle seam, not the orchestration logic the sibling file covers.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  ScriptRegistry,
  type AgentBrowserController,
  type ContentFetcher,
  type EthicsGate,
  type Extractor,
  type Logger,
  type ReportBuilder,
  type SearchProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import type { ConfirmationRequest } from '@yantra/protocol';
import { parseRuntimeLog } from '@yantra/test-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBriefPublisher } from '../../src/adapters/pi/tools/index.js';
import type { AgentProvider } from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  runAgenticTask,
  type AgenticRunEnvironment,
  type AgenticTaskDependencies,
} from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import { RunRuntimeLog } from '../../src/runtime/runtime-log.js';
import { FakeAgentProvider } from '../provider/fake-provider.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = true;
  public readonly outcomes: AgenticTaskOutcome[] = [];

  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'granted'> {
    return Promise.resolve('granted');
  }

  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Progress is not what these tests observe.
  }

  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    this.outcomes.push(outcome);
  }
}

interface Lifecycle {
  /** One ordered trace of every lifecycle step, across all collaborators. */
  readonly trace: string[];
  readonly outcome: AgenticTaskOutcome;
  readonly runDir: string;
  readonly closeCalls: () => number;
  readonly log: RunRuntimeLog | null;
}

/** A report builder that records when it ran, relative to everything else. */
function tracingReportBuilder(trace: string[], real: boolean): ReportBuilder {
  return {
    build: async (runDir, outcome, failure) => {
      trace.push('report:build');
      if (!real) return '';
      const { MarkdownReportBuilder } = await import('@yantra/core');
      return new MarkdownReportBuilder().build(runDir, outcome, failure);
    },
  };
}

function baseDomain(
  trace: string[],
  runDir: string,
  fetcher?: ContentFetcher,
): AgenticRunEnvironment['domain'] {
  const searchProvider: SearchProvider = { name: 'duckduckgo', search: () => Promise.resolve([]) };
  const extractor: Extractor = { extract: () => Promise.resolve(null) };
  const ethics: EthicsGate = { check: () => Promise.resolve() };
  return {
    search: {
      resolveProvider: () => Promise.resolve({ isOk: true, value: searchProvider }),
      resultCap: 5,
      fetchTop: 3,
    },
    fetch: {
      fetcher: fetcher ?? {
        fetch: () => {
          trace.push('fetch:called');
          return Promise.reject(new Error('unused'));
        },
      },
      extractor,
      ethics,
      allowedContentTypes: ['text/html'],
      maxContentBytes: 1024,
      captureThresholdBytes: 1024,
    },
    script: { registry: new ScriptRegistry() },
    publish: createBriefPublisher(runDir, { taskId: 'task', runId: 'run' }),
    browser: null,
    rank: null,
    workflow: null,
  };
}

interface RunOptions {
  readonly provider?: AgentProvider;
  readonly goal?: string;
  /** Throw here to exercise the partial-environment-construction path. */
  readonly failAfterLogOpen?: Error;
  readonly teardownError?: Error;
  readonly closeError?: Error;
  readonly signal?: AbortSignal;
  readonly realReport?: boolean;
  readonly openProviderSession?: boolean;
}

/**
 * Runs one task with a real {@link RunRuntimeLog}, tracing every lifecycle
 * step into a single ordered list.
 */
async function runWithLog(options: RunOptions = {}): Promise<Lifecycle> {
  const root = await mkdtemp(join(tmpdir(), 'yantra-runtime-lifecycle-'));
  tempDirs.push(root);
  const trace: string[] = [];
  let log: RunRuntimeLog | null = null;
  let closeCalls = 0;

  const createEnvironment: NonNullable<AgenticTaskDependencies['createEnvironment']> = (
    context,
  ) => {
    // Mirrors the production order: open the destination, then compose.
    log = RunRuntimeLog.open({ runId: context.runId, runDir: context.runDir });
    trace.push('log:open');
    const runtimeLogger: Logger = log.logger;
    if (options.failAfterLogOpen) {
      // Production closes the destination it opened before rethrowing; this
      // factory stands in for `createDefaultEnvironment`'s own catch.
      return log
        .close()
        .then(() => {
          closeCalls += 1;
          trace.push('log:close');
          throw options.failAfterLogOpen!;
        })
        .then(() => {
          throw options.failAfterLogOpen!;
        });
    }
    runtimeLogger.info({ event: 'browser_ready', schema_version: 1 }, 'composed');
    const environment: AgenticRunEnvironment = {
      browserController: {
        teardown: () => {
          trace.push('browser:teardown');
          // A terminal lifecycle line written DURING teardown must survive: it
          // is the evidence for why the run ended.
          runtimeLogger.info({ event: 'browser_torn_down' }, 'teardown');
          if (options.teardownError) return Promise.reject(options.teardownError);
          return Promise.resolve();
        },
      } as unknown as Pick<AgentBrowserController, 'teardown'>,
      domain: baseDomain(trace, context.runDir),
      runtimeLogger,
      closeRuntimeLog: () => {
        closeCalls += 1;
        trace.push('log:close');
        if (options.closeError) return Promise.reject(options.closeError);
        return log!.close();
      },
    };
    return Promise.resolve(environment);
  };

  const outcome = await runAgenticTask(
    {
      goal: options.goal ?? 'Complete the lifecycle fixture task',
      model: { provider: 'fixture', id: 'fixture-model' },
      auth: { mode: 'managed' },
      connector: new SilentConnector(),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      runStore: new LocalRunStore(root),
      sanitizer: new DefaultSanitizer(),
      createEnvironment,
      createProvider: () =>
        options.provider ??
        ({
          open: () => {
            trace.push('session:open');
            return new FakeAgentProvider().open({
              runId: 'r',
              runDir: root,
              cwd: root,
              model: { provider: 'fixture', id: 'fixture-model' },
              auth: { mode: 'managed' },
              systemPrompt: 'x',
            });
          },
        } as unknown as AgentProvider),
      reportBuilder: tracingReportBuilder(trace, options.realReport === true),
    },
  );

  return { trace, outcome, runDir: outcome.runDir, closeCalls: () => closeCalls, log };
}

describe('@no-llm agentic runtime log lifecycle', () => {
  it('closes after teardown and before the report, exactly once', async () => {
    const result = await runWithLog();

    expect(result.closeCalls()).toBe(1);
    const teardown = result.trace.indexOf('browser:teardown');
    const close = result.trace.indexOf('log:close');
    const report = result.trace.indexOf('report:build');
    expect(teardown).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(teardown);
    expect(report).toBeGreaterThan(close);
  });

  it('persists a line written during teardown', async () => {
    const result = await runWithLog();

    const lines = await parseRuntimeLog(
      await readFile(join(result.runDir, 'runtime.jsonl'), 'utf8'),
    );
    // The destination was still open while the browser tore down, so the
    // teardown line is on disk rather than lost to an early close.
    expect(lines.map((line) => line.event)).toEqual(['browser_ready', 'browser_torn_down']);
    expect(result.log?.isClosed()).toBe(true);
  });

  it('lists the artifact in the report it builds afterwards', async () => {
    const result = await runWithLog({ realReport: true });

    const report = await readFile(join(result.runDir, 'report.md'), 'utf8');
    expect(report).toContain('## Audit Trail');
    expect(report).toContain('- runtime.jsonl');
  });

  it('closes once when the run fails mid-flight', async () => {
    const provider = {
      open: () => Promise.reject(new Error('session start refused')),
    } as unknown as AgentProvider;

    const result = await runWithLog({ provider });

    expect(result.outcome.kind).toBe('failed');
    // A startup failure finalizes early and skips the teardown block, so that
    // branch owns the close itself — and must not double-close.
    expect(result.closeCalls()).toBe(1);
    expect(result.log?.isClosed()).toBe(true);
  });

  it('closes once when the user aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runWithLog({ signal: controller.signal });

    expect(result.closeCalls()).toBe(1);
    expect(result.log?.isClosed()).toBe(true);
    const lines = await parseRuntimeLog(
      await readFile(join(result.runDir, 'runtime.jsonl'), 'utf8'),
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('closes the destination it opened when environment construction fails', async () => {
    const boom = new Error('keychain unavailable');

    const result = await runWithLog({ failAfterLogOpen: boom });

    expect(result.outcome.kind).toBe('failed');
    expect(result.closeCalls()).toBe(1);
    expect(result.log?.isClosed()).toBe(true);
  });

  it('treats a close failure as a teardown failure without skipping finalization', async () => {
    const result = await runWithLog({ closeError: new Error('flush failed'), realReport: true });

    // The report is still built and the run is still finalized; the close
    // failure degrades a published outcome rather than losing the run.
    expect(result.trace).toContain('report:build');
    const report = await readFile(join(result.runDir, 'report.md'), 'utf8');
    expect(report.length).toBeGreaterThan(0);
  });

  it('still closes when browser teardown itself throws', async () => {
    const result = await runWithLog({ teardownError: new Error('chrome would not exit') });

    expect(result.closeCalls()).toBe(1);
    expect(result.log?.isClosed()).toBe(true);
    expect(result.trace.indexOf('log:close')).toBeGreaterThan(
      result.trace.indexOf('browser:teardown'),
    );
  });

  it('leaves a run without an environment with no artifact and an unchanged report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-runtime-preflight-'));
    tempDirs.push(root);
    const createEnvironment = vi.fn();

    // The location pre-flight gate refuses before any environment exists, so
    // this run legitimately has no runtime log at all.
    const outcome = await runAgenticTask(
      {
        goal: 'cheap hotels near me August 5 2026 2 nights',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
        ambient: { grants: { location: true }, userLocation: null },
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        createEnvironment,
      },
    );

    expect(outcome.kind).toBe('handoff');
    expect(createEnvironment).not.toHaveBeenCalled();
    await expect(readFile(join(outcome.runDir, 'runtime.jsonl'), 'utf8')).rejects.toThrow();
    const report = await readFile(join(outcome.runDir, 'report.md'), 'utf8');
    expect(report).not.toContain('runtime.jsonl');
  });
});
