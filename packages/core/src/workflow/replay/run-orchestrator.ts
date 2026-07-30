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

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief, Plan, SecretRef, SecurityScope } from '@yantra/protocol';

import { runsRoot } from '../../browser/paths.js';
import type { BrowserProvider } from '../../browser/types.js';
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
 * Maps an orchestrator outcome to a POSIX exit code.
 *
 * - 0: success
 * - 2: workflow logic failure (scope violation, ethics refused, step failure)
 * - 4: non-blocking abort (human handoff requested, user-aborted)
 */
export function exitCodeFor(outcome: OrchestratorRunOutcome): number {
  if (outcome.kind === 'success') return 0;
  if (outcome.kind === 'aborted') {
    const reason = outcome.reason;
    if (reason === 'user-handoff' || reason === 'user-abort') return 4;
    return 2; // scope-violation, ethics-refused
  }
  return 2; // failure
}

// ---------------------------------------------------------------------------
// RunOrchestrator
// ---------------------------------------------------------------------------

const REPORT_FILE = 'report.md';
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
   * @throws Never — all errors are captured into the outcome.
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
    const { plan, locatorTable, profileSpec, outputBindings, declaredSecretKeys, synthesisSpec } =
      translated;

    // 4. Preflight checks
    await preflightSecrets(declaredSecretKeys, this.opts.keychain);
    preflightWorkflow(workflow);

    // 5. Create run directory
    const { runId, runDir } = await this.opts.runStore.createRun(request);

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

    // 7. Write plan.json
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });

    // 8. Launch browser
    const browser = await this.opts.browserProvider.launch({
      profile: profileSpec,
      headless: true,
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

      return outcome;
    } finally {
      await this.opts.runStore.releaseLock(runId);
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
  public async resume(runId: string): Promise<OrchestratorRunOutcome> {
    const logger = this.opts.logger;

    // Load resume point (validates resumability)
    const point = await loadResumePoint(this.opts.runStore, runId);
    const { plan, nextStepIndex, lastCheckpoint, manifest, runDir } = point;

    // Update status to running
    manifest.status = 'running';
    await writeManifest(runDir, manifest);

    const browser = await this.opts.browserProvider.launch({
      profile:
        point.profileKind === 'workflow' && point.cookieProfilePath !== null
          ? { kind: 'explicit', absolutePath: point.cookieProfilePath }
          : { kind: 'ephemeral' },
      headless: true,
    });

    try {
      const secretResolver = new DefaultOpaqueRefResolver({ keychain: this.opts.keychain });

      const ctx = createExecutionContext({
        runId,
        taskId: manifest.taskId,
        plan,
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

      const outcome = this.mapExecutorOutcome(executorOutcome, runId, evaluated.persisted);

      manifest.status = outcome.kind === 'success' ? 'completed' : 'failed';
      manifest.endedAt = endedAt;
      manifest.durationMs = new Date(endedAt).getTime() - new Date(manifest.startedAt).getTime();
      if (outcome.kind === 'failure') {
        manifest.failureClass = outcome.failureClass;
      }
      await writeManifest(runDir, manifest);

      return outcome;
    } finally {
      await this.opts.runStore.releaseLock(runId);
      await browser.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
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
