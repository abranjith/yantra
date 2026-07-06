/**
 * Schedule-registration validation (FEAT-021 TASK-001).
 *
 * Reuses the existing, tested workflow machinery so a schedule can only be
 * registered for a workflow that is safe to run unattended (feature spec §2):
 *   - the workflow exists in the `WorkflowStore`,
 *   - it lints clean (no errors),
 *   - the cron expression parses (croner),
 *   - the params satisfy the workflow's declared params **and** contain no
 *     credential-shaped literals (via the shared `resolveParams` path).
 *
 * Extracted from the CLI command so the validation matrix is unit-testable
 * without a live commander program.
 */

import { lint, validateCron, nextFireIso, type NotifyTarget } from '@yantra/core';
import type { FileWorkflowStore } from '@yantra/core';
import { resolveParams, type ParamArg } from '@yantra/core/workflow/replay';

/** The subset of `WorkflowStore` this validator needs (mockable in tests). */
export interface WorkflowLoader {
  load: FileWorkflowStore['load'];
}

/** A validated registration ready to hand to `ScheduleStore.register`. */
export interface ValidatedRegistration {
  readonly workflowName: string;
  readonly cronExpr: string;
  readonly params: Record<string, string>;
  readonly notifyTarget: NotifyTarget;
  readonly nextFireAt: string | null;
}

/** Inputs to {@link validateRegistration} (already-parsed CLI options). */
export interface RegistrationInput {
  readonly workflowName: string;
  readonly cronExpr: string;
  /** Raw `key=value` param pairs (CLI `--params`). */
  readonly params: readonly ParamArg[];
  /** Optional `--params-file` path. */
  readonly paramsFile?: string;
  readonly notifyTarget: NotifyTarget;
  /** Injectable clock so the seeded `next_fire_at` is deterministic in tests. */
  readonly now?: Date;
}

/** Structured outcome so callers can render a clear error and exit 1. */
export type RegistrationResult =
  | { readonly ok: true; readonly registration: ValidatedRegistration }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a schedule registration end-to-end.
 *
 * @param input - Parsed registration options.
 * @param workflowStore - Store used to load + verify the target workflow.
 * @returns A validated registration, or a structured failure reason.
 */
export async function validateRegistration(
  input: RegistrationInput,
  workflowStore: WorkflowLoader,
): Promise<RegistrationResult> {
  // 1. Cron must parse.
  const cronCheck = validateCron(input.cronExpr);
  if (!cronCheck.ok) {
    return {
      ok: false,
      reason: `Invalid cron expression "${input.cronExpr}": ${cronCheck.reason}`,
    };
  }

  // 2. Workflow must exist and lint clean.
  const loaded = await workflowStore.load(input.workflowName).catch(() => null);
  if (!loaded?.isOk) {
    return {
      ok: false,
      reason: `Workflow "${input.workflowName}" not found or failed to parse.`,
    };
  }
  const workflow = loaded.value;
  const report = lint(workflow);
  if (report.errors.length > 0) {
    const first = report.errors[0]!;
    return {
      ok: false,
      reason: `Workflow "${input.workflowName}" has lint errors and cannot be scheduled: ${first.code} at ${first.path} — ${first.message}`,
    };
  }

  // 3. Params must satisfy the declared spec and contain no credential shapes.
  //    `resolveParams` performs coercion, required-check, and credential-shape
  //    rejection — the same path `yantra run` uses.
  let resolved: Record<string, unknown>;
  try {
    resolved = await resolveParams({
      cli: input.params,
      ...(input.paramsFile !== undefined ? { file: input.paramsFile } : {}),
      workflowParams: workflow.params,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // Persist params as strings (they are re-resolved/coerced at fire time from
  // the declared spec, exactly as an interactive `run` would).
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    params[key] = value instanceof Date ? value.toISOString() : String(value);
  }

  return {
    ok: true,
    registration: {
      workflowName: input.workflowName,
      cronExpr: input.cronExpr,
      params,
      notifyTarget: input.notifyTarget,
      nextFireAt: nextFireIso(input.cronExpr, input.now ?? new Date()),
    },
  };
}
