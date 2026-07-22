import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AgentBrowserController,
  BlocklistImpl,
  BrowserFallbackFetcher,
  DefaultOpaqueRefResolver,
  DefaultSanitizer,
  EthicsGateImpl,
  HttpFetcher,
  HybridContentFetcher,
  JsonlEventBus,
  LocalBrowserProvider,
  LocalProfileStore,
  MarkdownReportBuilder,
  RateLimiterImpl,
  ReadabilityExtractor,
  RobotsCacheImpl,
  ScriptRegistry,
  UserInputVault,
  createAskEthicsAdapter,
  createConfirmationStore,
  createKeychainProvider,
  loadEthicsConfig,
  loadSearchConfig,
  promoteAgentTrace,
  resolveSearchProvider,
  FileWorkflowStore,
  workflowsRoot,
  type AgentBrowserController as AgentBrowserControllerType,
  type PayloadSanitizer,
  type RankSignalSink,
  type ReportBuilder,
  type WorkflowStore,
} from '@yantra/core';
import {
  LocalRunStore,
  RunOrchestrator,
  type AgentRunStore,
  type OrchestratorRunOutcome,
  type RunStatus,
} from '@yantra/core/workflow/replay';
import { generateUlid, validateBrief, type FailureClass } from '@yantra/protocol';

import { PiAgentProvider } from '../adapters/pi/provider.js';
import {
  createBriefPublisher,
  createYantraTools,
  evidenceToSourceRecords,
  yantraToolCatalog,
} from '../adapters/pi/tools/index.js';
import { AgentStartupError, AgentSessionStartFailedError } from '../errors.js';
import type {
  AgentAuthSelection,
  AgentError,
  AgentEvent,
  AgentModelSelection,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../provider/types.js';

import { BudgetTracker, DEFAULT_BUDGET_LIMITS, type BudgetLimits } from './budget.js';
import { ConfirmationBridge } from './confirmation-bridge.js';
import type { AgentTaskConnector } from './connector.js';
import type { ToolStatus } from './middleware.js';
import type { AgenticTaskOutcome, PublishedBriefRef } from './outcome.js';
import { COMMAND_TASK_PROFILES, type CommandTaskProfile } from './profiles.js';
import { AGENT_SYSTEM_PROMPT, buildAgentUserPrompt, type AgentPromptBudgets } from './prompt.js';
import { RunRecorder } from './run-recorder.js';
import {
  ActionPhase,
  EvidenceLedger,
  EvidencePhase,
  type EvidenceEntry,
  type RunServices,
  type ToolDomainDeps,
  type WorkflowRunToolOutcome,
} from './run-services.js';
import { AgentTrace } from './trace.js';
import { UrlPolicy } from './url-policy.js';
import type { UrlPolicyConfig } from './url-policy.js';

/** Maximum consulted sources recapped inline in the completion nudge. */
const NUDGE_EVIDENCE_CAP = 10;

/**
 * Consecutive identical tool failures (same tool + same error code, with no
 * successful call in between) that trip the stuck-loop circuit breaker. A weak
 * model that keeps retrying an impossible action would otherwise burn the whole
 * per-tool budget; tripping here stops it early with a diagnostic failure. Sized
 * to still allow a couple of good-faith retries of a transient error.
 */
const REPEATED_TOOL_FAILURE_LIMIT = 4;

/**
 * Build the completion nudge sent once when a session run stops without a
 * successful publication. Small local models do not reliably map "terminal
 * publication capability" onto the registered tool, so the nudge names
 * `result_publish` and its minimal payload shape explicitly (this is a per-run
 * user message, not the governed system prompt — the no-tool-catalog rule
 * applies to `AGENT_SYSTEM_PROMPT` only).
 *
 * The nudge closes the run, it never re-opens it: when the evidence ledger has
 * entries, they are recapped inline with an explicit do-not-search-again
 * instruction (the orchestrator freezes the evidence phase at the same moment),
 * and a non-empty draft answer is anchored as the content to publish. The
 * observed alternative — a generic "publish with exact URLs" demand — sent a
 * small model on a second search trip that changed its conclusion.
 */
function buildCompletionNudge(evidence: readonly EvidenceEntry[], draft: string): string {
  const lines = [
    'Completion check: no validated result has been published, so the task is NOT complete. ' +
      'Plain chat text is not a result. You MUST now call the result_publish tool exactly ' +
      'once, passing {"brief": {"title": "...", "overview": "..."}} (key_findings optional).',
  ];
  if (evidence.length > 0) {
    lines.push(
      '',
      'You already consulted the sources below; they are attached to your published result ' +
        'automatically. Do NOT call web_search or web_fetch again and do NOT re-type URLs — ' +
        'publish now from the evidence you already have.',
    );
    evidence.slice(0, NUDGE_EVIDENCE_CAP).forEach((entry, index) => {
      lines.push(`[${index + 1}] ${entry.url}${entry.title === null ? '' : ` — ${entry.title}`}`);
    });
    if (evidence.length > NUDGE_EVIDENCE_CAP) {
      lines.push(`(+${evidence.length - NUDGE_EVIDENCE_CAP} more, also attached automatically)`);
    }
    if (draft.trim().length > 0) {
      lines.push(
        '',
        'Your previous message is your draft answer: publish it by putting it in "overview" ' +
          '(refine the wording only — do not change the conclusion).',
      );
    }
  } else {
    lines.push(
      '',
      'No user is available to answer questions, so a broad or ambiguous goal is NOT a ' +
        'blocker: choose the most reasonable interpretation yourself and publish what you can ' +
        'support. Only if publishing is genuinely impossible (for example, no source could be ' +
        'fetched), state the precise blocker and the safest next action instead.',
    );
  }
  return lines.join('\n');
}

/** Full enforced budget configuration for one agentic run. */
export interface AgentBudgetConfig extends BudgetLimits, AgentPromptBudgets {
  readonly maxProviderTokens?: number;
  readonly maxProviderCostUsd?: number;
  readonly confirmationWaitMs: number;
}

/** Production defaults; provider token/cost ceilings are opt-in and approximate. */
export const DEFAULT_AGENT_BUDGETS: AgentBudgetConfig = {
  ...DEFAULT_BUDGET_LIMITS,
  // The combined `web_search` tool does a provider search then fetches the top-N
  // hits in PARALLEL, so its wall time is ≈ search + one fetch round (not N×
  // fetches). Each parallel fetch is allotted a fraction of this budget
  // (web-search.ts FETCH_TIMEOUT_FRACTION), leaving headroom for the search and
  // extraction within the single per-tool timeout — sized a little above the
  // base 45s so a slow SERP plus one fetch round still completes.
  perToolTimeoutMs: 60 * 1000,
  confirmationWaitMs: 3 * 60 * 1000,
};

/** Public input for one run. Each call creates a new run and provider session. */
export interface AgenticTaskRequest {
  readonly goal: string;
  /** Least-privilege command preset; defaults to the existing `do` behavior. */
  readonly profile?: CommandTaskProfile;
  readonly model: AgentModelSelection;
  readonly auth: AgentAuthSelection;
  readonly budgets?: Partial<AgentBudgetConfig>;
  readonly allowedHosts?: readonly string[];
  readonly profileContext?: string;
  /**
   * True when a user is present for this run (interactive TTY): the per-run
   * prompt then states a user can approve protected actions but not answer
   * open-ended questions. Defaults to false (unattended), matching non-TTY,
   * `--json`, and scheduled surfaces.
   */
  readonly interactive?: boolean;
  readonly connector: AgentTaskConnector;
  /**
   * When set, a successful run promotes its browser trace into a saved workflow
   * of this name (`yantra do --save-as <name>`). Promotion failure is reported
   * but never fails the run (FEAT-027 TASK-004).
   */
  readonly saveAs?: string;
  /** User interrupt/caller cancellation. */
  readonly signal?: AbortSignal;
}

/** Run-store operations needed beyond the startup-only core interface. */
export interface AgenticRunStore extends AgentRunStore {
  updateRunStatus(
    runId: string,
    patch: {
      readonly status: RunStatus;
      readonly endedAt?: string;
      readonly failureClass?: FailureClass;
    },
  ): Promise<void>;
  releaseLock(runId: string): Promise<void>;
}

/** SDK-neutral environment assembled once after the run directory exists. */
export interface AgenticRunEnvironment {
  readonly domain: ToolDomainDeps;
  readonly browserController: Pick<AgentBrowserControllerType, 'teardown'>;
  readonly resolveModelSecret?: (secretRef: string) => Promise<string>;
  /** Workflow store used by `--save-as` promotion; omit to disable promotion. */
  readonly workflowStore?: WorkflowStore;
}

/** Injectable boundaries for hermetic lifecycle/chaos tests. */
export interface AgenticTaskDependencies {
  readonly runStore?: AgenticRunStore;
  readonly sanitizer?: PayloadSanitizer;
  readonly createEnvironment?: (context: {
    readonly runId: string;
    readonly runDir: string;
    readonly taskId: string;
    readonly rankSink: RankSignalSink | null;
  }) => Promise<AgenticRunEnvironment>;
  readonly createProvider?: (
    services: RunServices,
    environment: AgenticRunEnvironment,
  ) => AgentProvider;
  readonly reportBuilder?: ReportBuilder;
  readonly now?: () => Date;
  readonly cwd?: string;
  /** Test/embedding override (for example, HTTP on a loopback fixture site). */
  readonly urlPolicyConfig?: UrlPolicyConfig;
  /** CLI-composed local domain ranking sink; null/absent disables observation. */
  readonly rankSink?: RankSignalSink | null;
}

/**
 * Execute one complete multi-turn agentic web task.
 *
 * Side effects: creates/finalizes one run directory, opens one fresh provider
 * session, may lazily launch one ephemeral browser, streams connector progress,
 * persists audit/usage/Brief artifacts, and tears every resource down exactly
 * once on success, failure, budget exhaustion, or abort.
 *
 * @param request Sanitized-at-boundary goal plus model/auth/budget/connector selection.
 * @param dependencies Optional test/embedding boundaries; production uses Yantra defaults.
 * @returns A closed terminal outcome whose `runId` owns every produced artifact.
 */
export async function runAgenticTask(
  request: AgenticTaskRequest,
  dependencies: AgenticTaskDependencies = {},
): Promise<AgenticTaskOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const runStore = dependencies.runStore ?? new LocalRunStore();
  const sanitizer = dependencies.sanitizer ?? new DefaultSanitizer();
  const profile = request.profile ?? COMMAND_TASK_PROFILES.do;
  const budgetsConfig = normalizeBudgets({ ...profile.budgets, ...request.budgets });
  const taskId = generateUlid();
  const created = await runStore.createAgentRun({
    taskId,
    command: profile.command,
    partialAgent: { provider: request.model.provider, model: request.model.id },
  });

  let environment: AgenticRunEnvironment | undefined;
  let session: AgentSession | undefined;
  let recorder: RunRecorder | undefined;
  let unsubscribe: (() => void) | undefined;
  let events: JsonlEventBus | undefined;
  let latestRunResult: AgentRunResult | undefined;
  let executionState: ExecutionState | undefined;
  let startupFinalized = false;
  let terminal: AgenticTaskOutcome | undefined;
  const trace = new AgentTrace();
  const teardownErrors: Error[] = [];

  try {
    environment = await (dependencies.createEnvironment ?? createDefaultEnvironment)({
      runId: created.runId,
      runDir: created.runDir,
      taskId,
      rankSink: dependencies.rankSink ?? null,
    });
    const runAbort = new AbortController();
    const budgetTracker = new BudgetTracker(budgetsConfig);
    const actionPhase = new ActionPhase();
    const confirmationBridge = new ConfirmationBridge({
      connector: request.connector,
      timeoutMs: budgetsConfig.confirmationWaitMs,
      runSignal: runAbort.signal,
      remainingWallClockMs: () => budgetTracker.remainingWallClockMs(),
      store: createConfirmationStore(created.runDir),
      nowIso: () => now().toISOString(),
    });
    // One vault per run: the prompt builder tokenizes the user's own sensitive
    // values into `{{user:...}}` placeholders (model-visible), and the tool
    // middleware resolves them back to real values at the execution boundary.
    const userInput = new UserInputVault();
    const services: RunServices = {
      runId: created.runId,
      runDir: created.runDir,
      budgets: budgetTracker,
      sanitizer,
      userInput,
      urlPolicy: new UrlPolicy(budgetTracker, {
        maxUrlLength: dependencies.urlPolicyConfig?.maxUrlLength ?? 2048,
        requireHttps: dependencies.urlPolicyConfig?.requireHttps ?? true,
        ...(request.allowedHosts && request.allowedHosts.length > 0
          ? { allowedHosts: request.allowedHosts }
          : dependencies.urlPolicyConfig?.allowedHosts
            ? { allowedHosts: dependencies.urlPolicyConfig.allowedHosts }
            : {}),
      }),
      confirmation: { gateway: confirmationBridge, store: null },
      actionPhase,
      evidence: new EvidenceLedger(sanitizer),
      evidencePhase: new EvidencePhase(),
      trace,
      abortSignal: runAbort.signal,
      now: () => now().getTime(),
      nowIso: () => now().toISOString(),
      domain: environment.domain,
      workflowToolMode: profile.workflowToolMode,
    };
    const tools = createYantraTools(services, profile);
    const provider =
      dependencies.createProvider?.(services, environment) ??
      new PiAgentProvider({
        customTools: tools,
        ...(environment.resolveModelSecret
          ? { resolveSecret: environment.resolveModelSecret }
          : {}),
      });
    const userPrompt = buildAgentUserPrompt(
      {
        goal: request.goal,
        budgets: budgetsConfig,
        // Ambient facts use the injectable clock so hermetic tests can pin the
        // rendered date; timezone/locale default to the host inside the builder.
        ambient: { now: now() },
        ...(request.allowedHosts ? { allowedHosts: request.allowedHosts } : {}),
        ...(request.profileContext ? { profileContext: request.profileContext } : {}),
        attended: request.interactive === true,
        promptAddendum: profile.promptAddendum,
      },
      sanitizer,
      userInput,
    );

    session = await provider.open({
      runId: created.runId,
      runDir: created.runDir,
      cwd: dependencies.cwd ?? process.cwd(),
      model: request.model,
      auth: request.auth,
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });
    recorder = await RunRecorder.open({
      runId: created.runId,
      runDir: created.runDir,
      session,
      model: request.model,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      tools: yantraToolCatalog(services, profile),
    });
    events = new JsonlEventBus(join(created.runDir, 'events.jsonl'));
    events.publish({ task_id: taskId, at: now().toISOString(), kind: 'task_started' });

    const state = createExecutionState({
      request,
      session,
      connector: request.connector,
      runAbort,
      budgets: budgetsConfig,
      runId: created.runId,
      runDir: created.runDir,
    });
    executionState = state;
    unsubscribe = session.subscribe((event) => state.onEvent(event));

    latestRunResult = await state.runPrompt(userPrompt);
    // The pre-nudge response is the model's draft answer; capture it before
    // runPrompt resets it — the nudge anchors to it, and the deterministic
    // fallback publishes it when the nudge turn still does not publish.
    let preNudgeDraft = '';
    if (!state.interrupted && !state.published && latestRunResult?.outcome === 'completed') {
      preNudgeDraft = state.lastResponseText.trim();
      const evidenceEntries = services.evidence.entries();
      if (evidenceEntries.length > 0) {
        // With evidence in hand, the nudge turn is publish-only: further
        // web_search/web_fetch calls are rejected with EVIDENCE_FROZEN so the
        // model cannot re-investigate its way to a different conclusion.
        services.evidencePhase.freeze();
      }
      latestRunResult = await state.runPrompt(buildCompletionNudge(evidenceEntries, preNudgeDraft));
    }
    terminal =
      (await maybeAssembleUnpublishedResult(state, latestRunResult, services, preNudgeDraft)) ??
      (await resolveTerminalOutcome(state, latestRunResult, created.runId, created.runDir));
  } catch (error) {
    if (session === undefined) {
      const startup = toStartupError(error);
      await runStore.finalizeStartupFailure(created.runId, startup.toAgentError());
      startupFinalized = true;
      terminal = failed(created.runId, created.runDir, startup.toAgentError());
    } else {
      terminal = failed(created.runId, created.runDir, {
        code: 'AGENT_TOOL_FAILED',
        message: safeError(error),
      });
    }
  } finally {
    executionState?.dispose();
    unsubscribe?.();
    if (!startupFinalized) {
      await captureTeardown(() => environment?.browserController.teardown(), teardownErrors);
      await captureTeardown(() => session?.close(), teardownErrors);
      await captureTeardown(() => recorder?.close(latestRunResult), teardownErrors);

      // Persist the successful-interaction trace, then optionally promote it into
      // a saved workflow (`--save-as`). Both are best-effort: a trace/promotion
      // failure must NOT fail an otherwise-complete run (plan §6, FEAT-027).
      if (!trace.isEmpty()) {
        const traceErrors: Error[] = [];
        await captureTeardown(() => trace.finalize(created.runDir), traceErrors);
        terminal = await maybePromoteTrace({
          request,
          environment,
          trace,
          outcome: terminal,
        });
      }

      if (teardownErrors.length > 0 && terminal?.kind === 'published') {
        terminal = failed(created.runId, created.runDir, {
          code: 'AGENT_TOOL_FAILED',
          message: 'The task result was produced, but run teardown did not complete cleanly.',
        });
      }
      terminal ??= failed(created.runId, created.runDir, {
        code: 'AGENT_TOOL_FAILED',
        message: 'The agentic run ended without a terminal outcome.',
      });
      await finalizeRun({
        outcome: terminal,
        taskId,
        events,
        runStore,
        reportBuilder: dependencies.reportBuilder ?? new MarkdownReportBuilder(),
        now,
      });
    }
  }

  terminal ??= failed(created.runId, created.runDir, {
    code: 'AGENT_TOOL_FAILED',
    message: 'The agentic run could not be finalized.',
  });
  request.connector.renderAgentOutcome(terminal);
  return terminal;
}

interface ExecutionState {
  readonly interrupted: boolean;
  readonly published: boolean;
  readonly budgetReason: string | undefined;
  readonly userAborted: boolean;
  readonly lastError: AgentError | undefined;
  readonly handoff: { blocker: string; safestNextAction: string } | undefined;
  /** Set when the stuck-loop breaker stopped the run on repeated identical failures. */
  readonly repeatedFailure: { tool: string; errorCode: string } | undefined;
  /** Accumulated (post-sanitizer) assistant text of the most recent prompt run. */
  readonly lastResponseText: string;
  onEvent(event: AgentEvent): void;
  runPrompt(prompt: string): Promise<AgentRunResult | undefined>;
  dispose(): void;
}

function createExecutionState(input: {
  readonly request: AgenticTaskRequest;
  readonly session: AgentSession;
  readonly connector: AgentTaskConnector;
  readonly runAbort: AbortController;
  readonly budgets: AgentBudgetConfig;
  readonly runId: string;
  readonly runDir: string;
}): ExecutionState {
  const starts = new Map<string, number>();
  let providerTokens = 0;
  let providerCost = 0;
  let published = false;
  let budgetReason: string | undefined;
  let userAborted = false;
  let lastError: AgentError | undefined;
  let handoff: { blocker: string; safestNextAction: string } | undefined;
  let abortPromise: Promise<void> | undefined;
  let lastResponseText = '';
  // Stuck-loop breaker: the key of the current run of identical tool failures,
  // its consecutive count, and the captured detail once the limit trips.
  let failureStreakKey: string | undefined;
  let failureStreakCount = 0;
  let repeatedFailure: { tool: string; errorCode: string } | undefined;

  const interrupt = (reason: string): void => {
    if (reason === 'user') userAborted = true;
    else budgetReason ??= reason;
    if (!input.runAbort.signal.aborted) input.runAbort.abort(reason);
    abortPromise ??= input.session.abort().catch(() => undefined);
  };
  // No timer when the run is not time-bounded: Node coerces out-of-range
  // delays (including Infinity) to 1 ms, which would abort the run instantly.
  const wallTimer = Number.isFinite(input.budgets.wallClockMs)
    ? setTimeout(() => interrupt('wall-clock'), input.budgets.wallClockMs)
    : undefined;
  wallTimer?.unref?.();
  const onUserAbort = (): void => interrupt('user');
  if (input.request.signal?.aborted) onUserAbort();
  else input.request.signal?.addEventListener('abort', onUserAbort, { once: true });

  // Update the consecutive-identical-failure streak and trip the breaker once it
  // reaches the limit. A successful call resets the streak (forward progress);
  // a different failure key restarts the count. Denied/aborted results are
  // ignored — they are not the impossible-retry pattern this guards against.
  const trackFailureStreak = (tool: string, metadata: ReturnType<typeof toolMetadata>): void => {
    if (metadata.status === 'ok') {
      failureStreakKey = undefined;
      failureStreakCount = 0;
      return;
    }
    if (metadata.status !== 'error') return;
    const key = `${tool}:${metadata.errorCode ?? metadata.summary}`;
    if (key === failureStreakKey) failureStreakCount += 1;
    else {
      failureStreakKey = key;
      failureStreakCount = 1;
    }
    if (failureStreakCount >= REPEATED_TOOL_FAILURE_LIMIT && repeatedFailure === undefined) {
      repeatedFailure = { tool, errorCode: metadata.errorCode ?? 'TOOL_FAILED' };
      interrupt('repeated-tool-failure');
    }
  };

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'assistant_text':
        lastResponseText += event.text;
        input.connector.emitAgentEvent(event);
        if (/\b(captcha|bot[- ]wall|mfa)\b/i.test(event.text)) {
          handoff ??= {
            blocker: 'The site requires human verification or authentication.',
            safestNextAction: 'Complete the verification manually, then start a fresh run.',
          };
        }
        return;
      case 'tool_started':
        starts.set(event.callId, Date.parse(event.at));
        input.connector.emitAgentEvent({
          type: 'tool_started',
          tool: event.tool,
          summary: summarizeInput(event.input),
          at: event.at,
        });
        return;
      case 'tool_finished': {
        const metadata = toolMetadata(event.output, event.isError);
        const started = starts.get(event.callId);
        starts.delete(event.callId);
        input.connector.emitAgentEvent({
          type: 'tool_finished',
          tool: event.tool,
          summary: metadata.summary,
          status: metadata.status,
          durationMs: duration(started, event.at),
          at: event.at,
        });
        if (event.tool === 'result_publish' && metadata.status === 'ok') published = true;
        if (metadata.errorCode === 'BUDGET_EXHAUSTED' || metadata.errorCode === 'TOOL_TIMEOUT') {
          interrupt(metadata.errorCode === 'TOOL_TIMEOUT' ? 'per-tool-timeout' : 'tool-budget');
        }
        if (metadata.handoff) {
          handoff = {
            blocker: metadata.summary,
            safestNextAction:
              'Resolve the site restriction manually, then retry only if policy permits.',
          };
        }
        trackFailureStreak(event.tool, metadata);
        return;
      }
      case 'turn_finished':
        providerTokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
        providerCost += event.usage.costUsd ?? 0;
        if (
          input.budgets.maxProviderTokens !== undefined &&
          providerTokens >= input.budgets.maxProviderTokens
        ) {
          interrupt('provider-tokens');
        }
        if (
          input.budgets.maxProviderCostUsd !== undefined &&
          providerCost >= input.budgets.maxProviderCostUsd
        ) {
          interrupt('provider-cost');
        }
        return;
      case 'failed':
        lastError = event.error;
        return;
    }
  };

  const runPrompt = async (prompt: string): Promise<AgentRunResult | undefined> => {
    if (input.runAbort.signal.aborted) return undefined;
    // Each prompt run owns its own response text so a completion-missing
    // failure reports the post-nudge blocker, not earlier chatter.
    lastResponseText = '';
    const runPromise = input.session.run(prompt);
    const interrupted = new Promise<undefined>((resolve) => {
      input.runAbort.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    const result = await Promise.race([runPromise, interrupted]);
    if (result === undefined) {
      void runPromise.catch(() => undefined);
      await abortPromise;
    }
    return result;
  };

  return {
    get interrupted() {
      return budgetReason !== undefined || userAborted;
    },
    get published() {
      return published;
    },
    get budgetReason() {
      return budgetReason;
    },
    get userAborted() {
      return userAborted;
    },
    get lastError() {
      return lastError;
    },
    get handoff() {
      return handoff;
    },
    get repeatedFailure() {
      return repeatedFailure;
    },
    get lastResponseText() {
      return lastResponseText;
    },
    onEvent,
    runPrompt,
    dispose: () => {
      clearTimeout(wallTimer);
      input.request.signal?.removeEventListener('abort', onUserAbort);
    },
  };
}

/**
 * Deterministic fallback publication (zero-LLM): when the nudge turn still
 * ends without a publish but the run holds both a draft answer and ledger
 * evidence, the runtime assembles the Brief itself — the draft as overview,
 * the consulted sources (with excerpts) attached, `deterministic_fallback_used`
 * stamped, and an honest notice recording the assembly path. The protocol
 * invariant is unchanged (only a validated Brief is a published result);
 * what relaxes is authorship: the model supplies prose, the runtime supplies
 * structure. Assembly failures fall through to the normal failure path.
 *
 * @returns The published outcome, or undefined when assembly does not apply
 *   or did not produce a readable Brief.
 */
async function maybeAssembleUnpublishedResult(
  state: ExecutionState,
  result: AgentRunResult | undefined,
  services: RunServices,
  draft: string,
): Promise<AgenticTaskOutcome | undefined> {
  if (state.interrupted || state.published) return undefined;
  if (result?.outcome !== 'completed') return undefined;
  if (draft.length === 0 || services.evidence.isEmpty()) return undefined;

  // The draft is model text, so user-input values appear as placeholders;
  // resolve them for the published Brief — the artifact is the user's own
  // deliverable and must carry the real values (same contract as tool params).
  const overview = services.userInput?.resolve(draft) ?? draft;
  const published = await services.domain.publish.publish(
    {
      title: assembledTitle(overview),
      overview,
      key_findings: [],
      sources: evidenceToSourceRecords(services.evidence.entries()),
    },
    { assembledByRuntime: true },
  );
  if (!published.isOk) return undefined;
  services.actionPhase.close();

  const brief = await readPublishedBrief(services.runDir);
  if (brief === undefined) return undefined;
  return { kind: 'published', runId: services.runId, runDir: services.runDir, brief };
}

/** One-line title derived from the draft's first sentence-ish line (bounded). */
function assembledTitle(draft: string): string {
  const firstLine =
    draft
      .split(/\r?\n/u)
      .map((line) => line.replace(/^[#>*\-\s]+/u, '').trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return 'Task result';
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}

async function resolveTerminalOutcome(
  state: ExecutionState,
  result: AgentRunResult | undefined,
  runId: string,
  runDir: string,
): Promise<AgenticTaskOutcome> {
  // The stuck-loop breaker wins over the generic budget mapping it triggers, so
  // the failure reads as "repeated the same failing action" rather than a bare
  // budget-exhausted code.
  if (state.repeatedFailure !== undefined) {
    return failed(runId, runDir, {
      code: 'AGENT_TOOL_FAILED',
      message:
        `The run was stopped after the agent repeatedly failed the same action ` +
        `(${state.repeatedFailure.tool}: ${state.repeatedFailure.errorCode}) without making ` +
        `progress. Re-run once the underlying cause is resolved.`,
    });
  }
  if (state.budgetReason !== undefined) {
    return {
      kind: 'budget_exhausted',
      runId,
      runDir,
      error: {
        code: 'AGENT_BUDGET_EXHAUSTED',
        message: `Agent budget exhausted (${state.budgetReason}).`,
      },
    };
  }
  if (state.userAborted || result?.outcome === 'aborted') {
    return {
      kind: 'aborted',
      runId,
      runDir,
      error: { code: 'AGENT_ABORTED', message: 'The agentic run was interrupted.' },
    };
  }
  if (state.published) {
    const brief = await readPublishedBrief(runDir);
    if (brief !== undefined) return { kind: 'published', runId, runDir, brief };
  }
  if (result?.outcome === 'failed' || state.lastError !== undefined) {
    return failed(
      runId,
      runDir,
      state.lastError ?? { code: 'AGENT_TOOL_FAILED', message: 'The provider run failed.' },
    );
  }
  if (state.handoff !== undefined) {
    return { kind: 'handoff', runId, runDir, ...state.handoff };
  }
  // The nudge invites the model to state its blocker when it cannot publish;
  // surface that (already-sanitized) statement so the failure is diagnosable
  // from the CLI error and report.md instead of a bare completion code.
  const finalMessage = excerptText(state.lastResponseText, 400);
  const savedResultNote = await saveUnpublishedResult(runDir, state.lastResponseText);
  return failed(runId, runDir, {
    code: 'AGENT_COMPLETION_MISSING',
    message:
      'The session ended without a successful result publication after one completion nudge.' +
      savedResultNote +
      (finalMessage === undefined ? '' : ` Final agent message: ${finalMessage}`),
  });
}

/**
 * Best-effort salvage of the final (already-sanitized) assistant response when
 * the run ends without a validated publication: persist it as `result.md` so
 * the user still gets a file artifact instead of only a 400-char excerpt in
 * report.md. This is diagnostic output, not a published Brief — the run still
 * fails with AGENT_COMPLETION_MISSING (raw prose is not success, plan §5).
 *
 * @returns The sentence appended to the failure message, or '' when nothing
 *   was saved (no text, or the write failed).
 */
async function saveUnpublishedResult(runDir: string, responseText: string): Promise<string> {
  const text = responseText.trim();
  if (text.length === 0) return '';
  try {
    await writeFile(join(runDir, 'result.md'), `${text}\n`, 'utf8');
    return ' The full unvalidated response was saved to result.md.';
  } catch {
    return '';
  }
}

/** Collapse whitespace and bound the excerpt; undefined when there is no text. */
function excerptText(text: string, maxChars: number): string | undefined {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}...`;
}

async function readPublishedBrief(runDir: string): Promise<PublishedBriefRef | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as unknown;
    const result = validateBrief(raw);
    if (!result.isOk) return undefined;
    return {
      briefId: result.value.brief_id,
      jsonPath: join(runDir, 'brief.json'),
      markdownPath: join(runDir, 'brief.md'),
      htmlPath: join(runDir, 'brief.html'),
    };
  } catch {
    return undefined;
  }
}

async function finalizeRun(input: {
  readonly outcome: AgenticTaskOutcome;
  readonly taskId: string;
  readonly events: JsonlEventBus | undefined;
  readonly runStore: AgenticRunStore;
  readonly reportBuilder: ReportBuilder;
  readonly now: () => Date;
}): Promise<void> {
  const endedAt = input.now().toISOString();
  const mapping = finalizationFor(input.outcome);
  if (input.events !== undefined) {
    if (input.outcome.kind === 'published') {
      input.events.publish({
        task_id: input.taskId,
        at: endedAt,
        kind: 'task_completed',
        outputs_keys: ['brief'],
      });
    } else {
      input.events.publish({
        task_id: input.taskId,
        at: endedAt,
        kind: 'task_failed',
        failure_class: mapping.failureClass ?? 'unexpected',
        report_path: 'report.md',
      });
    }
    await input.events.close();
  }
  await input.runStore.updateRunStatus(input.outcome.runId, {
    status: mapping.status,
    endedAt,
    ...(mapping.failureClass ? { failureClass: mapping.failureClass } : {}),
  });
  await input.reportBuilder.build(
    input.outcome.runDir,
    input.outcome.kind === 'published' ? 'completed' : 'failed',
    input.outcome.kind === 'published'
      ? undefined
      : { failureClass: mapping.error.code, message: mapping.error.message },
  );
  await input.runStore.releaseLock(input.outcome.runId);
}

function finalizationFor(outcome: AgenticTaskOutcome): {
  readonly status: RunStatus;
  readonly failureClass?: FailureClass;
  readonly error: AgentError;
} {
  switch (outcome.kind) {
    case 'published':
      return { status: 'completed', error: { code: 'OK', message: 'Published.' } };
    case 'handoff':
      return {
        status: 'aborted',
        failureClass: /captcha/i.test(outcome.blocker) ? 'captcha_detected' : 'unexpected',
        error: { code: 'AGENT_TOOL_FAILED', message: outcome.blocker },
      };
    case 'budget_exhausted':
      return { status: 'failed', failureClass: 'budget_exhausted', error: outcome.error };
    case 'aborted':
      return { status: 'aborted', failureClass: 'user_aborted', error: outcome.error };
    case 'failed':
      // A missing/unvalidated publication is a validation-contract failure,
      // not an unexpected crash: keep manifest/events consistent with the
      // AGENT_COMPLETION_MISSING code report.md already shows.
      return {
        status: 'failed',
        failureClass:
          outcome.error.code === 'AGENT_COMPLETION_MISSING' ? 'validation_error' : 'unexpected',
        error: outcome.error,
      };
  }
}

/**
 * Promote the run's browser trace into a saved workflow when `--save-as` was
 * requested and the run published a result. Promotion is best-effort: any
 * failure (no store, lint error, name collision, save error) is reported on the
 * outcome but never changes a published run into a failure (plan §6).
 *
 * @returns The outcome, annotated with a {@link PromotionResult} when promotion
 *   was attempted; otherwise the outcome unchanged.
 */
async function maybePromoteTrace(input: {
  readonly request: AgenticTaskRequest;
  readonly environment: AgenticRunEnvironment | undefined;
  readonly trace: AgentTrace;
  readonly outcome: AgenticTaskOutcome | undefined;
}): Promise<AgenticTaskOutcome | undefined> {
  const { request, environment, trace, outcome } = input;
  const workflowName = request.saveAs?.trim();
  if (workflowName === undefined || workflowName.length === 0) return outcome;
  if (outcome?.kind !== 'published') return outcome;

  const store = environment?.workflowStore;
  if (!store) {
    return {
      ...outcome,
      promotion: {
        saved: false,
        workflowName,
        error: 'Workflow promotion is not available in this environment.',
      },
    };
  }

  try {
    const result = await promoteAgentTrace(trace.steps(), {
      workflowName,
      store,
      description: `Promoted from: ${request.goal}`,
    });
    return {
      ...outcome,
      promotion: result.isOk
        ? { saved: true, workflowName }
        : { saved: false, workflowName, error: result.error.message },
    };
  } catch (error) {
    return {
      ...outcome,
      promotion: {
        saved: false,
        workflowName,
        error: error instanceof Error ? error.message : 'Unexpected promotion failure.',
      },
    };
  }
}

/** Map a deterministic run outcome onto the model-visible workflow tool result. */
function mapWorkflowOutcome(
  outcome: OrchestratorRunOutcome,
  stepCount: number,
): WorkflowRunToolOutcome {
  switch (outcome.kind) {
    case 'success':
      return { ok: true, runId: outcome.runId, stepCount, outputs: outcome.outputs };
    case 'aborted':
      return {
        ok: false,
        errorCode: outcome.reason === 'user-handoff' ? 'WORKFLOW_HANDOFF' : 'WORKFLOW_ABORTED',
        message: `The workflow run was not completed (${outcome.reason}).`,
        runId: outcome.runId,
        retryable: false,
      };
    case 'failure':
      return {
        ok: false,
        errorCode: 'WORKFLOW_RUN_FAILED',
        message: `The workflow run failed (${outcome.failureClass}).`,
        runId: outcome.runId,
        retryable: false,
      };
  }
}

async function createDefaultEnvironment(context: {
  readonly runId: string;
  readonly runDir: string;
  readonly taskId: string;
  readonly rankSink: RankSignalSink | null;
}): Promise<AgenticRunEnvironment> {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const keychain = await createKeychainProvider();
  const ethicsConfig = await loadEthicsConfig();
  // Load the search config once for this run so the combined `web_search` tool's
  // breadth (resultCap) and inline-fetch depth (fetchTop) come from config,
  // not hardcoded constants. An invalid `search:` block fails loud here.
  const searchConfig = await loadSearchConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const ethics = new EthicsGateImpl(
    blocklist,
    new RobotsCacheImpl(ethicsConfig.userAgent),
    new RateLimiterImpl(ethicsConfig.rateLimitDefault, ethicsConfig.rateLimitOverrides, {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    }),
    ethicsConfig.userAgent,
    { enforceRobotsTxt: ethicsConfig.robotsEnabled },
  );
  const browserProvider = new LocalBrowserProvider({
    profileStore: new LocalProfileStore({ logger }),
    logger,
  });
  const browserController = new AgentBrowserController({
    runId: context.runId,
    browserProvider,
    logger,
  });
  const secretAudit = {
    appendSecretResolution: (entry: unknown) =>
      appendFile(join(context.runDir, 'secrets.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8'),
  };
  const secretResolver = new DefaultOpaqueRefResolver({ keychain, auditLogWriter: secretAudit });
  const searchEthics = createAskEthicsAdapter(ethics, {
    taskId: context.taskId,
    runId: context.runId,
    stepId: 'web_search',
    action: 'fetch',
  });
  const workflowStore = new FileWorkflowStore(workflowsRoot());

  return {
    browserController,
    workflowStore,
    domain: {
      search: {
        resolveProvider: async () => {
          const result = await resolveSearchProvider({
            env: process.env,
            config: searchConfig,
            deps: { keychain, browserProvider, ethicsGate: searchEthics, logger },
          });
          return result.isOk
            ? result
            : { isOk: false as const, error: { message: result.error.message } };
        },
        resultCap: 8,
        fetchTop: searchConfig.fetchTop,
      },
      fetch: {
        // Same hybrid strategy as the deterministic ask/research pipelines:
        // HTTP first, escalating to a headless-browser fetch when the server
        // refuses the bot UA (401/403) or returns a script-rendered shell that
        // Readability cannot extract (the EXTRACTION_EMPTY class of failures).
        fetcher: new HybridContentFetcher({
          httpFetcher: new HttpFetcher({ maxBodyBytes: 5 * 1024 * 1024 }),
          browserFetcher: new BrowserFallbackFetcher({ browserProvider }),
        }),
        extractor: new ReadabilityExtractor(),
        ethics,
        allowedContentTypes: ['text/html', 'text/plain'],
        maxContentBytes: 5 * 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
      script: { registry: new ScriptRegistry() },
      publish: createBriefPublisher(context.runDir, {
        taskId: context.taskId,
        runId: context.runId,
      }),
      workflow: {
        listCatalog: () => workflowStore.listCatalog(),
        run: async (input, ctx) => {
          // Each nested run gets its own run directory (RunOrchestrator owns
          // the run lifecycle). Confirmation checkpoints inside the workflow use
          // the bridged gateway; a null gateway fails those steps closed.
          const orchestrator = new RunOrchestrator({
            workflowStore,
            runStore: new LocalRunStore(),
            browserProvider,
            keychain,
            sanitizer: new DefaultSanitizer(),
            ethicsGate: ethics,
            logger,
            confirmationGateway: ctx.confirmationGateway,
          });
          let stepCount = 0;
          const loaded = await workflowStore.load(input.workflow);
          if (loaded.isOk) stepCount = loaded.value.steps.length;
          const outcome: OrchestratorRunOutcome = await orchestrator.run({
            workflowName: input.workflow,
            params: input.params,
            budgets: {},
            json: false,
            debug: false,
          });
          return mapWorkflowOutcome(outcome, stepCount);
        },
      },
      browser: {
        controller: browserController,
        ethics,
        secretResolver,
        // Host bindings are trusted metadata and are intentionally not inferred
        // from model input. A future config store can inject them here.
        secretHosts: () => Promise.resolve([]),
        captureThresholdBytes: 16 * 1024,
      },
      rank: context.rankSink,
    },
    resolveModelSecret: async (secretRef: string) => {
      const value = await keychain.get('yantra', secretRef);
      if (value === null)
        throw new Error(`Runtime model secret reference "${secretRef}" was not found.`);
      return value;
    },
  };
}

function normalizeBudgets(overrides: Partial<AgentBudgetConfig> | undefined): AgentBudgetConfig {
  const merged = { ...DEFAULT_AGENT_BUDGETS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'perToolCallOverrides') continue;
    // The wall clock is the one budget that may be unbounded: runs are
    // unlimited by default and time-bounding is an explicit override.
    if (key === 'wallClockMs' && value === Number.POSITIVE_INFINITY) continue;
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Agent budget "${key}" must be a positive finite number.`);
    }
  }
  return merged;
}

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return 'started';
  const keys = Object.keys(input).slice(0, 5);
  return keys.length > 0 ? `fields: ${keys.join(', ')}` : 'no input fields';
}

function toolMetadata(
  output: unknown,
  isError: boolean,
): {
  readonly status: ToolStatus;
  readonly errorCode: string | undefined;
  readonly summary: string;
  readonly handoff: boolean;
} {
  const record = asRecord(output);
  const details = asRecord(record?.details);
  const status =
    record?.status === 'denied' || record?.status === 'aborted' || record?.status === 'error'
      ? record.status
      : isError
        ? 'error'
        : 'ok';
  const errorCode = stringValue(record?.error_code ?? record?.errorCode);
  return {
    status,
    errorCode,
    summary: errorCode ? `${status}: ${errorCode}` : status,
    handoff:
      details?.handoff === true ||
      errorCode === 'CONFIRMATION_DENIED' ||
      errorCode === 'CONFIRMATION_TIMEOUT' ||
      errorCode === 'CONFIRMATION_UNAVAILABLE',
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function duration(started: number | undefined, endedAt: string): number | null {
  const ended = Date.parse(endedAt);
  return started === undefined || Number.isNaN(started) || Number.isNaN(ended)
    ? null
    : Math.max(0, ended - started);
}

function failed(runId: string, runDir: string, error: AgentError): AgenticTaskOutcome {
  return { kind: 'failed', runId, runDir, error };
}

function toStartupError(error: unknown): AgentStartupError {
  return error instanceof AgentStartupError
    ? error
    : new AgentSessionStartFailedError(safeError(error));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected agent runtime failure.';
}

async function captureTeardown(
  operation: () => Promise<void> | undefined,
  errors: Error[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
}
