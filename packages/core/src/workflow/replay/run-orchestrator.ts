/**
 * RunOrchestrator — end-to-end workflow run lifecycle manager.
 *
 * Drives the full run pipeline:
 *   params → translate → preflight → store → browser → executor → outputs →
 *   synthesize → report
 *
 * The `synthesize` stage is opt-in (a workflow declaring `synthesis:`) and
 * best-effort: it never changes a run's outcome, only enriches it with a Brief.
 *
 * Dependencies are injected to keep this class testable without a live browser.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JsonValue,
  TASK_OUTCOME_TABLE,
  type Brief,
  type FailureClass,
  type Plan,
  type SecretRef,
  type SecurityScope,
  type TaskOutcome,
} from '@yantra/protocol';

import { runsRoot } from '../../browser/paths.js';
import type { BrowserLaunchContext, BrowserProvider } from '../../browser/types.js';
import type { Logger } from '../../browser/types.js';
import type { ConfirmationGateway } from '../../executor/confirmation-gateway.js';
import { createExecutionContext } from '../../executor/execution-context.js';
import { Executor } from '../../executor/executor.js';
import type {
  EthicsGate,
  ExecutionContext,
  LLMClient,
  RunOutcome as ExecutorRunOutcome,
  Sanitizer,
} from '../../executor/types.js';
import { writeFileAtomic } from '../../fs/atomic-write.js';
import { ResourceBusyError } from '../../locks/resource-lock.js';
import {
  writeExecutionReceipt,
  type ExecutionReceiptDraft,
} from '../../receipt/execution-receipt.js';
import { recordReceiptWritten } from '../../run-events/receipt-written.js';
import {
  abandonOwnedStream,
  emitArtifactSaved,
  runOutcomeEvent,
} from '../../run-events/run-facts.js';
import { RunEventStream } from '../../run-events/stream.js';
import type { KeychainProvider } from '../../secrets/keychain.js';
import { DefaultOpaqueRefResolver } from '../../secrets/resolver.js';
import type { WorkflowStore } from '../store.types.js';

import { checkChromeDrift } from './chrome-drift.js';
import { WorkflowNotFoundError } from './errors.js';
import { writeManifest, writeOutputs, redactParamsForManifest } from './manifest-writer.js';
import { evaluateOutputs, redactOutputsForDisk } from './output-evaluator.js';
import { resolveParams } from './params-resolver.js';
import { preflightEthics, preflightSecrets, preflightWorkflow } from './preflight.js';
import { MarkdownReportRenderer } from './report-renderer.js';
import { loadResumePoint } from './resume.js';
import { runSynthesizeStage, synthesizeGate, type SynthesisStrategies } from './synthesize.js';
import type { RunStore } from './types.js';
import type {
  BriefRunArtifacts,
  FailureDetail,
  OrchestratorRunOutcome,
  ParamArg,
  RunManifest,
  RunReport,
  RunRequest,
  TranslatedWorkflow,
} from './types.js';
import { translate } from './workflow-to-plan.js';

// ---------------------------------------------------------------------------
// Injection interface
// ---------------------------------------------------------------------------

export interface RunOrchestratorOptions {
  readonly workflowStore: WorkflowStore;
  readonly runStore: RunStore;
  readonly browserProvider: BrowserProvider;
  readonly keychain: KeychainProvider;
  readonly sanitizer?: Sanitizer | null;
  readonly ethicsGate: EthicsGate;
  readonly llmClient?: LLMClient | null;
  readonly logger: Logger;
  readonly clock?: { now(): Date };
  /**
   * Human-in-the-loop consent gateway (FEAT-019). When a workflow contains a
   * `requires_confirmation` step, the executor blocks on this gateway. When
   * omitted (`null`), a flagged step fails closed (user-handoff abort) — never
   * auto-confirmed. Interactive CLI runs inject an `InteractiveConfirmationGateway`;
   * unattended surfaces leave it null so they cannot self-authorize (plan §6).
   */
  readonly confirmationGateway?: ConfirmationGateway | null;
  /**
   * Synthesize-stage strategies (FEAT-FP-001). Supplied by `apps/cli` for
   * `yantra run`; omitted (or null) disables the stage entirely, which is what
   * every caller that must stay zero-LLM *and* artifact-free relies on.
   *
   * Providing `{ deterministic, llm: null, noLlm: true }` is the hard zero-LLM
   * configuration: a Brief is still produced, but no provider session is ever
   * opened. Scheduled runs and nested `workflow_run` calls use exactly that.
   */
  readonly synthesis?: SynthesisStrategies | null;
}

// ---------------------------------------------------------------------------
// Exit code helpers
// ---------------------------------------------------------------------------

/**
 * Maps an orchestrator outcome to its exit code through the protocol's one
 * outcome table, so `yantra run` and the agentic commands agree word for word
 * (REV-011):
 *
 * - 0: success (`fulfilled`)
 * - 2: workflow logic failure — scope violation, ethics refused, step failure (`failed`)
 * - 4: human handoff requested (`handoff`)
 * - 130: user abort (`aborted`)
 */
export function exitCodeFor(outcome: OrchestratorRunOutcome): number {
  return TASK_OUTCOME_TABLE[taskOutcomeForReplay(outcome)].exitCode;
}

/**
 * The task-outcome word for a replay outcome (FEAT-054 D3), so `yantra run`
 * speaks the same vocabulary as the agentic commands. {@link exitCodeFor} reads
 * each word's exit code from the shared table.
 *
 * - `success` → `fulfilled`
 * - `aborted` with `user-handoff` → `handoff`; with `user-abort` → `aborted`
 * - any other abort (scope violation, ethics refusal) and `failure` → `failed`
 */
export function taskOutcomeForReplay(outcome: OrchestratorRunOutcome): TaskOutcome {
  switch (outcome.kind) {
    case 'success':
      return 'fulfilled';
    case 'aborted':
      if (outcome.reason === 'user-handoff') return 'handoff';
      if (outcome.reason === 'user-abort') return 'aborted';
      return 'failed';
    case 'failure':
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// RunOrchestrator
// ---------------------------------------------------------------------------

const REPORT_FILE = 'report.md';
const OUTPUTS_FILE = 'outputs.json';
const REPORT_JSON_FILE = 'report.json';

export class RunOrchestrator {
  private readonly executor = new Executor();
  private readonly renderer = new MarkdownReportRenderer();

  public constructor(private readonly opts: RunOrchestratorOptions) {}

  // -------------------------------------------------------------------------
  // run()
  // -------------------------------------------------------------------------

  /**
   * Executes a workflow from scratch.
   *
   * @returns The orchestrator outcome (success, failure, or aborted).
   * Validation and browser-startup refusals propagate typed to the adapter;
   * executor outcomes are returned.
   */
  public async run(request: RunRequest): Promise<OrchestratorRunOutcome> {
    const clock = this.opts.clock ?? { now: () => new Date() };
    const logger = this.opts.logger;

    // 1. Load workflow
    const loadResult = await this.opts.workflowStore.load(request.workflowName);
    if (!loadResult.isOk) {
      throw new WorkflowNotFoundError(request.workflowName, runsRoot());
    }
    const workflow = loadResult.value;

    // 2. Resolve params
    const cliParams: ParamArg[] = Object.entries(request.params).map(([key, value]) => ({
      key,
      rawValue: typeof value === 'string' ? value : String(value),
    }));
    const resolveInput: {
      cli: readonly ParamArg[];
      file?: string;
      workflowParams: typeof workflow.params extends infer T ? T : never;
    } =
      request.paramsFile !== undefined
        ? { cli: cliParams, file: request.paramsFile, workflowParams: workflow.params }
        : { cli: cliParams, workflowParams: workflow.params };
    const params = await resolveParams(resolveInput);

    // 3. Translate workflow → plan
    const translated = translate(workflow, params);
    const { plan, profileSpec, outputBindings, declaredSecretKeys } = translated;

    // 4. Preflight checks
    await preflightSecrets(declaredSecretKeys, this.opts.keychain);
    preflightWorkflow(workflow);

    // 5. Create run directory
    const { runId, runDir } = await this.opts.runStore.createRun(request);
    // FEAT-063: the run's event stream. A caller-supplied stream is already
    // subscribed by its renderer; otherwise this run owns one.
    const ownsRunEvents = request.runEvents === undefined;
    const runEvents = request.runEvents ?? new RunEventStream({ logger });
    if (request.receipt) {
      const written = await writeExecutionReceipt(runDir, {
        ...request.receipt,
        settings: [
          ...request.receipt.settings.filter(
            (s) => s.key !== 'synthesis.use_llm' && s.key !== 'params',
          ),
          {
            key: 'params',
            value: JsonValue.parse(redactParamsForManifest(params, declaredSecretKeys)),
            source: request.receipt.settings.find((s) => s.key === 'params')?.source ?? {
              kind: 'workflow',
            },
          },
          {
            key: 'synthesis.use_llm',
            value: workflow.synthesis?.use_llm ?? false,
            source: workflow.synthesis ? { kind: 'workflow' } : { kind: 'default' },
          },
        ],
      });
      // Committed as an early line once the log opens.
      await recordReceiptWritten(runEvents, written.path);
    }

    const taskId = plan.task_id;
    const startedAt = clock.now().toISOString();

    // 6. Write initial manifest
    const manifest: RunManifest = {
      runId,
      taskId,
      workflowName: workflow.name,
      workflowVersion: workflow.version ?? null,
      status: 'running',
      startedAt,
      endedAt: undefined,
      durationMs: undefined,
      failureClass: undefined,
      profileKind: profileSpec.kind,
      cookieProfilePath: profileSpec.kind === 'workflow' ? null : null,
      params: redactParamsForManifest(params, declaredSecretKeys),
      outputBindingNames: outputBindings.map((b) => b.name),
      chromeDriftWarning: undefined,
    };
    await writeManifest(runDir, manifest);

    // 6b. Open the run's event log (FEAT-063). Anything emitted so far is
    // committed as its first lines.
    try {
      await this.openRunEvents(runEvents, runId, runDir, manifest);
      this.opts.runStore.ownership?.(runId)?.attachEvents(runEvents);
      try {
        return await this.runAfterOpen({
          request,
          workflow,
          params,
          translated,
          manifest,
          runId,
          runDir,
          taskId,
          startedAt,
          runEvents,
        });
      } catch (error) {
        abandonOwnedStream(runEvents, ownsRunEvents, runId, error);
        throw error;
      }
    } finally {
      // FEAT-064 order: the terminal manifest and event are flushed, and the
      // run's browser has exited, before the lease is released.
      await this.opts.runStore.releaseOwnership(runId);
    }
  }

  /** Steps 7 onward of {@link run}, once the run's event log is open. */
  private async runAfterOpen(input: {
    readonly request: RunRequest;
    readonly workflow: Parameters<typeof translate>[0];
    readonly params: Awaited<ReturnType<typeof resolveParams>>;
    readonly translated: TranslatedWorkflow;
    readonly manifest: RunManifest;
    readonly runId: string;
    readonly runDir: string;
    readonly taskId: string;
    readonly startedAt: string;
    readonly runEvents: RunEventStream;
  }): Promise<OrchestratorRunOutcome> {
    const clock = this.opts.clock ?? { now: () => new Date() };
    const logger = this.opts.logger;
    const { workflow, params, translated, manifest, runId, runDir, taskId, startedAt, runEvents } =
      input;
    const { plan, locatorTable, profileSpec, outputBindings, synthesisSpec } = translated;

    // 7. Write plan.json
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });

    // 8. Launch browser
    const browser = await this.opts.browserProvider
      .launch(
        {
          profile: profileSpec,
          headless: true,
        },
        ownershipContext(this.opts.runStore, runId),
      )
      .catch(async (error: unknown) => {
        if (error instanceof ResourceBusyError)
          await this.recordStartupRefusal(runId, runDir, manifest, error, runEvents);
        throw error;
      });

    try {
      // Update manifest with profile path
      if (profileSpec.kind === 'workflow') {
        manifest.cookieProfilePath = browser.profilePath;
        await writeManifest(runDir, manifest);
      }

      // 9. Chrome drift check
      checkChromeDrift(browser.chrome.majorVersion, workflow, manifest, {
        publish: (event) => {
          /* events.json will be written by execution context */
          logger.warn({ event }, 'chrome_drift_warning');
        },
        flush: () => Promise.resolve(undefined),
        persistedAt: () => '',
        close: () => Promise.resolve(undefined),
      });
      await writeManifest(runDir, manifest);

      // 10. Ethics preflight (navigate steps with literal URLs)
      await preflightEthics(plan, this.opts.ethicsGate, { taskId, runId });

      // 11. Build SecretResolver
      const secretResolver = new DefaultOpaqueRefResolver({ keychain: this.opts.keychain });

      // 12. Build execution context
      const ctx = createExecutionContext({
        runId,
        taskId,
        plan,
        params,
        runDir,
        browser,
        secrets: {
          resolve: async (ref: SecretRef): Promise<string> => {
            const resolved = await secretResolver.resolve(ref, {
              taskParams: params,
              captures: {},
              stepId: '',
              taskId,
            });
            try {
              return resolved.value;
            } finally {
              resolved.dispose();
            }
          },
        },
        sanitizer: this.opts.sanitizer ?? null,
        llmClient: this.opts.llmClient ?? null,
        ethics: this.opts.ethicsGate,
        workflowLocators: {
          resolve: (name: string) => locatorTable[name] ?? null,
        },
        confirmationGateway: this.opts.confirmationGateway ?? null,
        logger,
        runEvents,
      });

      // 13. Execute
      const executorOutcome = await this.executor.run(ctx);

      // 14. Evaluate outputs
      const captureSnapshot = ctx.captures.snapshot();
      const evaluated = await evaluateOutputs(outputBindings, {
        captures: captureSnapshot.entries,
        params,
      });

      // Write outputs.json (persisted, redacted)
      const endedAt = clock.now().toISOString();
      const redacted = redactOutputsForDisk(evaluated.persisted);
      await writeOutputs(runDir, {
        runId,
        workflowName: workflow.name,
        createdAt: endedAt,
        outputs: redacted,
      });
      emitArtifactSaved(runEvents, runDir, join(runDir, OUTPUTS_FILE), 'output');

      // 15. Map executor outcome → orchestrator outcome + update manifest
      const baseOutcome = this.mapExecutorOutcome(executorOutcome, runId, evaluated.persisted);

      // 15b. Synthesize stage — only for a completed run that declared the
      // block and a caller that wired strategies. Best-effort throughout: the
      // outcome above is already final, and this can only add a Brief to it.
      const brief = await this.maybeSynthesize({
        synthesisSpec,
        securityClass: workflow.security_class,
        completed: baseOutcome.kind === 'success',
        ctx,
        manifest,
        runDir,
        runId,
        taskId,
      });

      const outcome: OrchestratorRunOutcome =
        baseOutcome.kind === 'success' && brief.artifacts !== null
          ? { ...baseOutcome, brief: brief.artifacts }
          : baseOutcome;
      if (brief.artifacts !== null) {
        for (const path of [
          brief.artifacts.jsonPath,
          brief.artifacts.mdPath,
          brief.artifacts.htmlPath,
        ])
          emitArtifactSaved(runEvents, runDir, path, 'brief');
      }

      manifest.status = outcome.kind === 'success' ? 'completed' : 'failed';
      manifest.endedAt = endedAt;
      manifest.durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
      if (outcome.kind === 'failure') {
        manifest.failureClass = outcome.failureClass;
      }
      await writeManifest(runDir, manifest);

      // 16. Render and write report
      const stepLog = buildStepLog(plan, ctx);
      const reportFailure: FailureDetail | undefined =
        outcome.kind === 'failure' ? outcome.failureDetail : undefined;
      const report: RunReport = {
        manifest,
        stepLog,
        outputs: evaluated,
        auditEntries: [],
        ...(reportFailure === undefined ? {} : { failure: reportFailure }),
        ...(brief.brief === null ? {} : { brief: brief.brief }),
      };

      const markdown = this.renderer.render(report);
      const jsonSummary = this.renderer.renderJson(report);
      await writeFile(join(runDir, REPORT_FILE), markdown, { encoding: 'utf8', mode: 0o600 });
      await writeFile(join(runDir, REPORT_JSON_FILE), JSON.stringify(jsonSummary, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      emitArtifactSaved(runEvents, runDir, join(runDir, REPORT_FILE), 'report');
      emitArtifactSaved(runEvents, runDir, join(runDir, REPORT_JSON_FILE), 'report');

      // The run's last event; the stream closes once the manifest is final.
      this.recordOutcome(runEvents, outcome, clock.now().toISOString());
      return outcome;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // resume()
  // -------------------------------------------------------------------------

  /**
   * Resumes a previously failed or paused run.
   *
   * The caller should use `requiresUserConsent()` to gate this call when the
   * original failure class was `scope_violation` or `ethics_refused`.
   */
  public async resume(
    runId: string,
    options: {
      readonly receipt?: ExecutionReceiptDraft;
      /** As {@link RunRequest.runEvents}: caller-owned when given. */
      readonly runEvents?: RunEventStream;
    } = {},
  ): Promise<OrchestratorRunOutcome> {
    // Load resume point (validates resumability)
    const point = await loadResumePoint(this.opts.runStore, runId);
    const { manifest, runDir } = point;
    const ownsRunEvents = options.runEvents === undefined;
    const runEvents = options.runEvents ?? new RunEventStream({ logger: this.opts.logger });

    if (options.receipt) {
      const written = await writeExecutionReceipt(runDir, options.receipt, { resume: true });
      await recordReceiptWritten(runEvents, written.path);
    }

    // FEAT-064: own the run before its manifest says running again.
    await this.opts.runStore.acquireOwnership?.(runId, {
      command: ['resume'],
      origin: options.receipt?.invoked_by ?? 'terminal',
    });
    try {
      // Update status to running; a resumed run is no longer interrupted.
      manifest.status = 'running';
      delete (manifest as { executionState?: unknown }).executionState;
      await writeManifest(runDir, manifest);

      // A resume continues the run's own log: seq picks up after the original
      // execution, and `task_resumed` opens the new segment.
      await this.openRunEvents(runEvents, runId, runDir, manifest);
      this.opts.runStore.ownership?.(runId)?.attachEvents(runEvents);
      try {
        return await this.resumeAfterOpen(runId, point, runEvents);
      } catch (error) {
        abandonOwnedStream(runEvents, ownsRunEvents, runId, error);
        throw error;
      }
    } finally {
      await this.opts.runStore.releaseOwnership(runId);
    }
  }

  private async resumeAfterOpen(
    runId: string,
    point: Awaited<ReturnType<typeof loadResumePoint>>,
    runEvents: RunEventStream,
  ): Promise<OrchestratorRunOutcome> {
    const logger = this.opts.logger;
    const { plan, nextStepIndex, lastCheckpoint, manifest, runDir } = point;

    const browser = await this.opts.browserProvider
      .launch(
        {
          profile:
            point.profileKind === 'workflow' && point.cookieProfilePath !== null
              ? { kind: 'explicit', absolutePath: point.cookieProfilePath }
              : { kind: 'ephemeral' },
          headless: true,
        },
        ownershipContext(this.opts.runStore, runId),
      )
      .catch(async (error: unknown) => {
        if (error instanceof ResourceBusyError)
          await this.recordStartupRefusal(runId, runDir, manifest, error, runEvents);
        throw error;
      });

    try {
      const secretResolver = new DefaultOpaqueRefResolver({ keychain: this.opts.keychain });

      const ctx = createExecutionContext({
        runId,
        taskId: manifest.taskId,
        plan,
        params: manifest.params,
        runDir,
        browser,
        secrets: {
          resolve: async (ref: SecretRef): Promise<string> => {
            const resolved = await secretResolver.resolve(ref, {
              taskParams: manifest.params,
              captures: {},
              stepId: '',
              taskId: manifest.taskId,
            });
            try {
              return resolved.value;
            } finally {
              resolved.dispose();
            }
          },
        },
        sanitizer: this.opts.sanitizer ?? null,
        llmClient: this.opts.llmClient ?? null,
        ethics: this.opts.ethicsGate,
        confirmationGateway: this.opts.confirmationGateway ?? null,
        logger,
        runEvents,
      });

      // Emit task_resumed event
      ctx.events.publish({
        kind: 'task_resumed',
        task_id: manifest.taskId,
        at: new Date().toISOString(),
        original_run_id: runId,
        resume_step_id: plan.steps[nextStepIndex]?.id ?? plan.steps[0]?.id ?? '',
      });

      // Execute from checkpoint
      let executorOutcome: ExecutorRunOutcome;
      if (lastCheckpoint !== null) {
        executorOutcome = await this.executor.resumeFrom(lastCheckpoint, ctx);
      } else {
        executorOutcome = await this.executor.run(ctx);
      }

      // Map outcome
      const captureSnapshot = ctx.captures.snapshot();

      // Reload workflow for output bindings
      const loadResult = await this.opts.workflowStore.load(manifest.workflowName);
      const outputBindings = loadResult.isOk
        ? translate(loadResult.value, manifest.params).outputBindings
        : [];

      const evaluated = await evaluateOutputs(outputBindings, {
        captures: captureSnapshot.entries,
        params: manifest.params,
      });

      const endedAt = new Date().toISOString();
      const redacted = redactOutputsForDisk(evaluated.persisted);
      await writeOutputs(runDir, {
        runId,
        workflowName: manifest.workflowName,
        createdAt: endedAt,
        outputs: redacted,
      });
      emitArtifactSaved(runEvents, runDir, join(runDir, OUTPUTS_FILE), 'output');

      const outcome = this.mapExecutorOutcome(executorOutcome, runId, evaluated.persisted);

      manifest.status = outcome.kind === 'success' ? 'completed' : 'failed';
      manifest.endedAt = endedAt;
      manifest.durationMs = new Date(endedAt).getTime() - new Date(manifest.startedAt).getTime();
      if (outcome.kind === 'failure') {
        manifest.failureClass = outcome.failureClass;
      }
      await writeManifest(runDir, manifest);

      this.recordOutcome(runEvents, outcome, new Date().toISOString());
      return outcome;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers

  /**
   * Opens the run's event log. A log that cannot be opened is an environment
   * failure before the run proceeds: it is recorded through the startup
   * failure path (failed manifest, report, `task_failed`) and rethrown.
   */
  private async openRunEvents(
    runEvents: RunEventStream,
    runId: string,
    runDir: string,
    manifest: RunManifest,
  ): Promise<void> {
    try {
      runEvents.open({ runDir, runId, logger: this.opts.logger });
    } catch (error) {
      await this.recordStartupFailure(runId, runDir, manifest, {
        message: error instanceof Error ? error.message : String(error),
        auditEntries: [],
        runEvents: null,
      });
      throw error;
    }
  }

  /** Records the run's one `run_outcome` (its last event) and closes the stream. */
  private recordOutcome(
    runEvents: RunEventStream,
    outcome: OrchestratorRunOutcome,
    at: string,
  ): void {
    const taskOutcome = taskOutcomeForReplay(outcome);
    runEvents.emit(
      runOutcomeEvent({
        runId: outcome.runId,
        taskOutcome,
        terminationReason: null,
        stopDetail: null,
        exitCode: TASK_OUTCOME_TABLE[taskOutcome].exitCode,
        failureClass: replayFailureClass(outcome),
        at,
      }),
    );
    runEvents.close();
  }
  // -------------------------------------------------------------------------

  /**
   * Runs the Synthesize stage when this run both declared it and earned it.
   *
   * Skipped — returning the empty result — when the workflow declares no
   * `synthesis:` block, when the caller wired no strategies, or when the run did
   * not complete (a failed run's evidence is partial by definition, and a Brief
   * over it would read as an answer). Records `manifest.synthesis` as a side
   * effect so `resume` can inherit the strategy.
   */
  private async maybeSynthesize(input: {
    readonly synthesisSpec: TranslatedWorkflow['synthesisSpec'];
    readonly securityClass: SecurityScope;
    readonly completed: boolean;
    readonly ctx: ExecutionContext;
    readonly manifest: RunManifest;
    readonly runDir: string;
    readonly runId: string;
    readonly taskId: string;
  }): Promise<{ brief: Brief | null; artifacts: BriefRunArtifacts | null }> {
    const gate = synthesizeGate({
      synthesisSpec: input.synthesisSpec,
      strategies: this.opts.synthesis ?? null,
      completed: input.completed,
    });
    if (!gate.run) {
      return { brief: null, artifacts: null };
    }

    const ledger = input.ctx.evidence;
    const stage = await runSynthesizeStage(
      {
        spec: gate.spec,
        evidence: ledger?.entries() ?? [],
        overflowCount: ledger?.overflowCount() ?? 0,
        scope: input.securityClass,
        taskId: input.taskId,
        runId: input.runId,
        runDir: input.runDir,
        strategies: gate.strategies,
      },
      this.opts.logger,
    );

    if (stage.record !== null) {
      input.manifest.synthesis = stage.record;
    }
    return { brief: stage.brief, artifacts: stage.artifacts };
  }

  /** A busy startup already owns a run directory; never leave it marked running. */
  private async recordStartupRefusal(
    runId: string,
    runDir: string,
    manifest: RunManifest,
    error: ResourceBusyError,
    runEvents: RunEventStream,
  ): Promise<void> {
    await this.recordStartupFailure(runId, runDir, manifest, {
      message: `${error.message} ${error.remediation}`,
      auditEntries: [{ kind: 'resource_busy', resource: error.resource, holder: error.holder }],
      runEvents,
    });
  }

  /** Finalizes a run that failed before its first step as an auditable failure. */
  private async recordStartupFailure(
    runId: string,
    runDir: string,
    manifest: RunManifest,
    failure: {
      readonly message: string;
      readonly auditEntries: RunReport['auditEntries'];
      readonly runEvents: RunEventStream | null;
    },
  ): Promise<void> {
    const endedAt = (this.opts.clock?.now() ?? new Date()).toISOString();
    manifest.status = 'failed';
    manifest.taskOutcome = 'failed';
    manifest.failureClass = 'unexpected';
    manifest.endedAt = endedAt;
    manifest.durationMs = Math.max(
      0,
      new Date(endedAt).getTime() - new Date(manifest.startedAt).getTime(),
    );
    const report: RunReport = {
      manifest,
      stepLog: [],
      failure: {
        failureClass: 'unexpected',
        stepId: 'startup',
        message: failure.message,
      },
      auditEntries: failure.auditEntries,
    };
    // Ownership is released by run()/resume() once the outcome is recorded.
    await writeManifest(runDir, manifest);
    const reportPath = join(runDir, REPORT_FILE);
    await writeFileAtomic(reportPath, this.renderer.render(report));
    await writeFileAtomic(
      join(runDir, REPORT_JSON_FILE),
      JSON.stringify(this.renderer.renderJson(report), null, 2),
    );
    const taskFailed = {
      kind: 'task_failed',
      task_id: manifest.taskId,
      at: endedAt,
      failure_class: 'unexpected',
      task_outcome: 'failed',
      report_path: reportPath,
    } as const;
    await appendFile(join(runDir, 'events.jsonl'), `${JSON.stringify(taskFailed)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    failure.runEvents?.emit(taskFailed);
  }

  private mapExecutorOutcome(
    outcome: ExecutorRunOutcome,
    runId: string,
    outputs: Record<string, unknown>,
  ): OrchestratorRunOutcome {
    switch (outcome.status) {
      case 'completed':
        return { kind: 'success', runId, outputs };

      case 'handoff':
        return { kind: 'aborted', runId, reason: 'user-handoff' };

      case 'failed':
        return {
          kind: 'failure',
          runId,
          failureClass: outcome.failureClass,
          failureDetail: {
            failureClass: outcome.failureClass,
            stepId: '',
            message: `Run failed with class: ${outcome.failureClass}`,
          },
        };
    }
  }
}

/** The failure class a replay outcome records on its `run_outcome`. */
function replayFailureClass(outcome: OrchestratorRunOutcome): FailureClass | null {
  switch (outcome.kind) {
    case 'success':
      return null;
    case 'failure':
      return outcome.failureClass;
    case 'aborted':
      switch (outcome.reason) {
        case 'user-handoff':
          return null;
        case 'user-abort':
          return 'user_aborted';
        case 'scope-violation':
          return 'scope_violation';
        case 'ethics-refused':
          return 'ethics_refused';
      }
  }
}

// ---------------------------------------------------------------------------
// Step log builder
// ---------------------------------------------------------------------------

function buildStepLog(plan: Plan, ctx: ExecutionContext): RunReport['stepLog'] {
  // Best effort — executor doesn't yet expose per-step timing
  return plan.steps.slice(0, ctx.currentStepIdx).map((step) => ({
    stepId: step.id,
    type: step.type,
    status: 'ok' as const,
  }));
}

/** The launch context that records the run's browsers in its lease (FEAT-064). */
function ownershipContext(runStore: RunStore, runId: string): BrowserLaunchContext {
  const recorder = runStore.ownership?.(runId)?.recorder;
  return recorder === undefined ? {} : { ownershipRecorder: recorder };
}
