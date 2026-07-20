/**
 * The mandatory tool middleware pipeline (FEAT-024 TASK-002, plan_agentic.md §5).
 *
 * Every Yantra tool is wrapped by {@link wrapTool}, which composes — in this
 * exact order — the enforcement stages the model and provider cannot omit:
 *
 * ```text
 * validated call
 *   -> input validation (closed schema)
 *   -> budget / timeout / abort check
 *   -> host + ethics + scope policy (+ action-phase latch)
 *   -> confirmation gateway (when the spec classifies risk)
 *   -> domain operation (AbortSignal threaded)
 *   -> sanitizer + output bounding
 *   -> stable tool result
 *   -> audit/event/usage persistence (via the run recorder, from seam events)
 * ```
 *
 * Expected failures become structured tool results with stable codes and a
 * retryability flag; unexpected exceptions are caught, logged, and mapped to a
 * generic provider tool error that never leaks secrets or raw content. The
 * middleware is provider-neutral (no Pi SDK import) — the Pi wrappers under
 * `adapters/pi/tools/` translate {@link WrappedTool} into Pi `defineTool`
 * definitions.
 */

import { isParked, type SanitizationProfile } from '@yantra/core';
import { generateUlid, type ConfirmationRequest } from '@yantra/protocol';
import pino from 'pino';
import type { Static, TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

import type { RunServices } from './run-services.js';

const logger = pino({ name: 'yantra-tool-middleware', level: process.env.LOG_LEVEL ?? 'info' });

/** Terminal status of a wrapped tool call — mirrors the ToolAuditEntry status. */
export type ToolStatus = 'ok' | 'error' | 'denied' | 'aborted';

/**
 * The stable, provider-neutral tool result the middleware produces. The Pi
 * layer maps `modelText` to tool `content` and carries `status`/`error_code`/
 * `confirmation_id` so the run recorder can project them into `tool-calls.jsonl`.
 */
export interface YantraToolResult {
  /** Terminal status. */
  readonly status: ToolStatus;
  /** Bounded, sanitized text the model sees. */
  readonly modelText: string;
  /** Artifacts for audit/UI — never automatically exposed to the model. */
  readonly details: unknown;
  /** Stable machine error code, present on non-`ok` results. */
  readonly error_code?: string;
  /** Whether a corrected retry could succeed (guidance for the agent loop). */
  readonly retryable?: boolean;
  /** Confirmation id when a consent gateway resolved this call. */
  readonly confirmation_id?: string;
  /** Hint that the agent should stop after this tool batch (terminal tools). */
  readonly terminate?: boolean;
}

/** Successful domain-operation output before sanitization/bounding. */
export interface DomainSuccess {
  readonly ok: true;
  /** Model-visible payload (object or string); the middleware sanitizes/bounds it. */
  readonly model: unknown;
  /** Optional artifacts recorded in `details` (not model-visible). */
  readonly details?: unknown;
  /** Terminal tools set this to close the run after the batch. */
  readonly terminate?: boolean;
}

/** Expected (structured) domain failure — a stable-coded tool result. */
export interface DomainFailure {
  readonly ok: false;
  /** Stable machine code. */
  readonly errorCode: string;
  /** Secret-free explanation for the model and audit. */
  readonly message: string;
  /** Whether a corrected retry could succeed. */
  readonly retryable: boolean;
  /** Optional artifacts recorded in `details`. */
  readonly details?: unknown;
}

/** A domain operation's result: structured success or structured failure. */
export type DomainResult = DomainSuccess | DomainFailure;

/** Context handed to a domain operation. */
export interface DomainContext {
  /** The per-run services bundle. */
  readonly services: RunServices;
  /** Merged abort signal (run abort ∪ per-tool timeout). Threaded into I/O. */
  readonly signal: AbortSignal;
  /** Confirmation id when consent was granted for this call, else null. */
  readonly confirmationId: string | null;
}

/** Fields the middleware needs to build a `ConfirmationRequest`. */
export interface ConfirmationSpec {
  /** Mutating verb classification (protocol requires click/fill/navigate). */
  readonly action_kind: ConfirmationRequest['action_kind'];
  /** Resolved target host. */
  readonly host: string;
  /** Human-readable summary of what will happen on grant. */
  readonly description: string;
  /** Best-effort cost estimate. */
  readonly expected_cost?: ConfirmationRequest['expected_cost'];
  /** Reversibility classification. */
  readonly consequence?: ConfirmationRequest['consequence'];
}

/** Context for a spec's optional pre-domain policy hook. */
export interface PolicyContext {
  readonly services: RunServices;
}

/**
 * Everything a tool wrapper declares (plan §5). Enforced by the contract test
 * harness (TASK-003): schema closedness, description quality, result bounding,
 * stable error codes, cancellation behaviour.
 */
export interface ToolWrapperSpec<TParams extends TSchema = TSchema> {
  /** Stable snake_case name (unique within the catalog). */
  readonly name: string;
  /** Concise UI label. */
  readonly label: string;
  /** Description stating when to use it AND when NOT to (quality-gated). */
  readonly description: string;
  /** Closed TypeBox input schema (additionalProperties:false) with field docs. */
  readonly parameters: TParams;
  /** Sanitization profile applied to the model-visible result. */
  readonly sanitizationProfile: SanitizationProfile;
  /** True when this call must be rejected after the action phase closes. */
  readonly mutating?: boolean;
  /**
   * True for tools that gather new web evidence (`web_search`, `web_fetch`).
   * Once the orchestrator freezes the evidence phase at completion-nudge time,
   * these calls are rejected with `EVIDENCE_FROZEN` so the model can only
   * package the evidence it already collected.
   */
  readonly evidenceGathering?: boolean;
  /**
   * Optional pre-domain policy hook (host/ethics/scope beyond the standard
   * budget/URL checks). Returns a structured failure to refuse, or null to
   * proceed.
   */
  readonly policy?: (
    params: Static<TParams>,
    ctx: PolicyContext,
  ) => Promise<DomainFailure | null> | DomainFailure | null;
  /** When present and truthy for the params, consent is required before the op. */
  readonly requiresConfirmation?: (params: Static<TParams>) => boolean;
  /** Build the confirmation request payload (middleware fills id/timestamp/timeout). */
  readonly buildConfirmation?: (params: Static<TParams>, services: RunServices) => ConfirmationSpec;
  /** The SDK-neutral domain operation. */
  readonly run: (params: Static<TParams>, ctx: DomainContext) => Promise<DomainResult>;
}

/** The provider-neutral wrapped tool `createYantraTools` turns into Pi defs. */
export interface WrappedTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  /** Execute the fully-guarded pipeline for one raw tool call. */
  execute(rawParams: unknown, signal: AbortSignal | undefined): Promise<YantraToolResult>;
}

/** Default per-run confirmation wait ceiling (minutes, not hours — plan §5). */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Wrap a tool spec with the mandatory middleware pipeline for one run.
 *
 * @param spec The tool's declared contract and domain operation.
 * @param services The per-run dependency bundle.
 * @returns A provider-neutral wrapped tool whose `execute` runs every stage.
 */
export function wrapTool<TParams extends TSchema>(
  spec: ToolWrapperSpec<TParams>,
  services: RunServices,
): WrappedTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: (rawParams, signal) => runPipeline(spec, services, rawParams, signal),
  };
}

async function runPipeline<TParams extends TSchema>(
  spec: ToolWrapperSpec<TParams>,
  services: RunServices,
  rawParams: unknown,
  callSignal: AbortSignal | undefined,
): Promise<YantraToolResult> {
  try {
    // 1. Input validation — a closed schema rejects unknown/invalid input
    //    before any budget, policy, or domain code runs.
    if (!Check(spec.parameters, rawParams)) {
      // TypeBox reports the failing location as `instancePath` (JSON pointer);
      // older releases used `path`. Without it the model cannot tell WHICH
      // field failed, so a weak model has no structured retry path.
      const first = Errors(spec.parameters, rawParams)[0] as
        | { path?: string; instancePath?: string; message?: string }
        | undefined;
      const pointer = first?.instancePath ?? first?.path;
      const where = pointer !== undefined && pointer.length > 0 ? ` at "${pointer}"` : '';
      return failure(
        spec,
        services,
        'INVALID_INPUT',
        `Invalid tool input${where}: ${first?.message ?? 'schema validation failed'}.`,
        true,
      );
    }
    const params = rawParams;

    // 2. Budget / timeout / abort check.
    if (isAborted(services, callSignal)) {
      return abortedResult(spec, services);
    }
    const reserved = services.budgets.reserveCall(spec.name);
    if (!reserved.isOk) {
      return failure(spec, services, reserved.error.code, reserved.error.message, false);
    }

    // 3. Host + ethics + scope policy, plus the action-phase latch: after a
    //    successful publish, mutating tools are structurally rejected.
    if (spec.mutating && services.actionPhase.isClosed()) {
      return failure(
        spec,
        services,
        'ACTION_PHASE_CLOSED',
        'The result has already been published; mutating tools are no longer available.',
        false,
      );
    }
    // Evidence-phase latch: once the completion nudge closed evidence
    // gathering, the only forward path is packaging what was already fetched.
    if (spec.evidenceGathering && services.evidencePhase.isFrozen()) {
      return failure(
        spec,
        services,
        'EVIDENCE_FROZEN',
        'Evidence gathering is closed for this run. Call result_publish now with your title ' +
          'and overview — the sources you already fetched are attached automatically.',
        false,
      );
    }
    if (spec.policy) {
      const refusal = await spec.policy(params, { services });
      if (refusal) {
        return fromFailure(spec, services, refusal);
      }
    }

    // 4. Confirmation gateway (blocking bounded wait — plan §5).
    let confirmationId: string | null = null;
    if (spec.requiresConfirmation?.(params)) {
      const consent = await runConfirmation(spec, services, params);
      if (consent.kind === 'denied') {
        return {
          status: 'denied',
          modelText: jsonText({
            status: 'denied',
            error_code: consent.errorCode,
            message: consent.message,
          }),
          details: null,
          error_code: consent.errorCode,
          retryable: false,
          ...(consent.confirmationId ? { confirmation_id: consent.confirmationId } : {}),
        };
      }
      confirmationId = consent.confirmationId;
    }

    // 5. Domain operation with AbortSignal threaded + per-tool timeout.
    const guarded = await runGuarded(
      (signal) => spec.run(params, { services, signal, confirmationId }),
      services,
      callSignal,
    );
    if (guarded.kind === 'aborted') {
      return abortedResult(spec, services, confirmationId);
    }
    if (guarded.kind === 'timeout') {
      return {
        status: 'error',
        modelText: jsonText({
          status: 'error',
          error_code: 'TOOL_TIMEOUT',
          message: `Tool "${spec.name}" exceeded its ${services.budgets.perToolTimeoutMs}ms execution budget.`,
          retryable: true,
        }),
        details: null,
        error_code: 'TOOL_TIMEOUT',
        retryable: true,
        ...(confirmationId ? { confirmation_id: confirmationId } : {}),
      };
    }
    const domain = guarded.value;
    if (!domain.ok) {
      return fromFailure(spec, services, domain, confirmationId);
    }

    // 6. Sanitizer + output bounding, then 7. stable tool result.
    const bounded = sanitizeAndBound(domain.model, spec.sanitizationProfile, services);
    const account = services.budgets.accountResultBytes(bounded.bytes);
    if (!account.isOk) {
      return {
        status: 'error',
        modelText: jsonText({
          status: 'error',
          error_code: account.error.code,
          message: account.error.message,
          retryable: false,
        }),
        details: domain.details ?? null,
        error_code: account.error.code,
        retryable: false,
        ...(confirmationId ? { confirmation_id: confirmationId } : {}),
      };
    }
    return {
      status: 'ok',
      modelText: bounded.text,
      details: domain.details ?? null,
      ...(domain.terminate ? { terminate: true } : {}),
      ...(confirmationId ? { confirmation_id: confirmationId } : {}),
    };
  } catch (error) {
    // 8. Unexpected exception: audited, genericized. No secret/raw-content leak.
    logger.error(
      { tool: spec.name, err: error instanceof Error ? error.message : String(error) },
      'unexpected tool error',
    );
    return failure(
      spec,
      services,
      'TOOL_EXECUTION_FAILED',
      `The "${spec.name}" tool failed unexpectedly.`,
      true,
    );
  }
}

/** Standard structured-failure result builder (secret-free by construction). */
function failure<TParams extends TSchema>(
  _spec: ToolWrapperSpec<TParams>,
  _services: RunServices,
  errorCode: string,
  message: string,
  retryable: boolean,
): YantraToolResult {
  return {
    status: 'error',
    modelText: jsonText({ status: 'error', error_code: errorCode, message, retryable }),
    details: null,
    error_code: errorCode,
    retryable,
  };
}

/** Convert a DomainFailure into a stable tool result. */
function fromFailure<TParams extends TSchema>(
  _spec: ToolWrapperSpec<TParams>,
  _services: RunServices,
  domain: DomainFailure,
  confirmationId: string | null = null,
): YantraToolResult {
  return {
    status: 'error',
    modelText: jsonText({
      status: 'error',
      error_code: domain.errorCode,
      message: domain.message,
      retryable: domain.retryable,
    }),
    details: domain.details ?? null,
    error_code: domain.errorCode,
    retryable: domain.retryable,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  };
}

/** Aborted-run result (no side effect executed). */
function abortedResult<TParams extends TSchema>(
  _spec: ToolWrapperSpec<TParams>,
  _services: RunServices,
  confirmationId: string | null = null,
): YantraToolResult {
  return {
    status: 'aborted',
    modelText: jsonText({
      status: 'aborted',
      error_code: 'AGENT_ABORTED',
      message: 'The run was aborted.',
    }),
    details: null,
    error_code: 'AGENT_ABORTED',
    retryable: false,
    ...(confirmationId ? { confirmation_id: confirmationId } : {}),
  };
}

/** True when either the run signal or the call signal is already aborted. */
function isAborted(services: RunServices, callSignal: AbortSignal | undefined): boolean {
  return services.abortSignal.aborted || callSignal?.aborted === true;
}

type ConsentOutcome =
  | { readonly kind: 'granted'; readonly confirmationId: string }
  | {
      readonly kind: 'denied';
      readonly errorCode: string;
      readonly message: string;
      readonly confirmationId: string | null;
    };

/**
 * Run the bounded blocking confirmation wait. Timeout and non-interactive
 * (parked) surfaces both fail closed (plan §5): the protected action never runs.
 */
async function runConfirmation<TParams extends TSchema>(
  spec: ToolWrapperSpec<TParams>,
  services: RunServices,
  params: Static<TParams>,
): Promise<ConsentOutcome> {
  const confirmationServices = services.confirmation;
  if (!confirmationServices || !spec.buildConfirmation) {
    // A tool that classifies risk with no gateway wired fails closed.
    return {
      kind: 'denied',
      errorCode: 'CONFIRMATION_UNAVAILABLE',
      message: 'This action requires confirmation, but no consent surface is available.',
      confirmationId: null,
    };
  }

  const spec_ = spec.buildConfirmation(params, services);
  const confirmationId = generateUlid();
  const waitMs = Math.min(DEFAULT_CONFIRMATION_TIMEOUT_MS, services.budgets.remainingWallClockMs());
  const request: ConfirmationRequest = {
    confirmation_id: confirmationId,
    run_id: services.runId,
    step_id: `${spec.name}:${confirmationId.slice(-6)}`,
    action_kind: spec_.action_kind,
    host: spec_.host,
    description: spec_.description,
    expected_cost: spec_.expected_cost ?? null,
    consequence: spec_.consequence ?? 'unknown',
    requested_at: services.nowIso(),
    timeout_ms: waitMs > 0 ? Math.floor(waitMs) : 1,
  };

  await confirmationServices.store?.appendRequest(request);
  const outcome = await confirmationServices.gateway.request(request);

  // Parked = an unattended surface that cannot self-authorize → fail closed.
  if (isParked(outcome)) {
    return {
      kind: 'denied',
      errorCode: 'CONFIRMATION_TIMEOUT',
      message:
        'Confirmation could not be obtained (non-interactive run); the action was not taken.',
      confirmationId,
    };
  }

  await confirmationServices.store?.appendDecision(outcome);
  if (outcome.decision === 'granted') {
    return { kind: 'granted', confirmationId };
  }
  return {
    kind: 'denied',
    errorCode: outcome.decision === 'timed_out' ? 'CONFIRMATION_TIMEOUT' : 'CONFIRMATION_DENIED',
    message:
      outcome.decision === 'timed_out'
        ? 'Confirmation timed out; the action was not taken.'
        : 'Confirmation was denied; the action was not taken.',
    confirmationId,
  };
}

type GuardOutcome =
  | { readonly kind: 'result'; readonly value: DomainResult }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/**
 * Run a domain op racing the per-tool timeout and the run/call abort signals.
 * On timeout or abort, the merged signal is aborted so the op can cancel its
 * I/O; the middleware returns promptly without awaiting a stuck op.
 */
async function runGuarded(
  op: (signal: AbortSignal) => Promise<DomainResult>,
  services: RunServices,
  callSignal: AbortSignal | undefined,
): Promise<GuardOutcome> {
  const controller = new AbortController();
  const timeoutMs = services.budgets.perToolTimeoutMs;

  const onExternalAbort = (): void => controller.abort('external');
  const externalSignals = [services.abortSignal, callSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  for (const signal of externalSignals) {
    if (signal.aborted) controller.abort('external');
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<GuardOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort('timeout');
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref?.();
    controller.signal.addEventListener(
      'abort',
      () => {
        if (controller.signal.reason === 'external') resolve({ kind: 'aborted' });
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      op(controller.signal).then<GuardOutcome>((value) => ({ kind: 'result', value })),
      guard,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of externalSignals) signal.removeEventListener('abort', onExternalAbort);
  }
}

interface BoundedText {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/** Sanitize a model payload and hard-bound it to the per-result byte budget. */
function sanitizeAndBound(
  payload: unknown,
  profile: SanitizationProfile,
  services: RunServices,
): BoundedText {
  const sanitized = services.sanitizer.sanitize(payload, profile);
  const capped = truncateToBytes(sanitized.text, services.budgets.maxBytesPerResult);
  return {
    text: capped.text,
    bytes: Buffer.byteLength(capped.text, 'utf8'),
    truncated: sanitized.truncated || capped.truncated,
  };
}

/** UTF-8-safe truncation to at most `maxBytes` bytes (no split multibyte char). */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back off to a UTF-8 boundary (bytes 0x80–0xBF are continuation bytes).
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** Compact JSON for a failure/status result the model can parse. */
function jsonText(value: unknown): string {
  return JSON.stringify(value);
}
