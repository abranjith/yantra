/**
 * Engine-enforced no-submit (FEAT-054).
 *
 * Under `effects.submit: forbidden`, a submit-class click and a saved workflow
 * that could click are refused by the tool's pre-domain policy hook. The hook
 * runs before the confirmation gate, so no consent prompt is ever built and no
 * submission handler fires. The contract only ever removes capability here: an
 * `allowed` run behaves exactly as before.
 */

import type { SubmitSignal } from '@yantra/core';

import { renderAgentMessage } from './messages.js';
import type { DomainFailure } from './middleware.js';
import type { RunServices, WorkflowStepShape } from './run-services.js';

/** Why a submit-class action was refused. */
export type SubmitRefusalSignal = SubmitSignal | 'nested-workflow';

/** Most workflows one no-submit check loads through `call_workflow`. */
const MAX_WORKFLOWS_CHECKED = 16;

/** True when the run's contract, across every revision, forbids submitting. */
export function submitForbidden(services: RunServices): boolean {
  return services.contract.effectiveActionTerms().submit.value === 'forbidden';
}

/**
 * The typed refusal for a submit-class action, logged as one `submit_refused`
 * runtime line (signal and host only, never the control's name).
 *
 * @param name The refused control's accessible name, for the model-visible message.
 */
export function submitRefusal(
  services: RunServices,
  signal: SubmitRefusalSignal,
  name: string,
): DomainFailure {
  const host = services.domain.browser?.controller.host() ?? '';
  services.runtimeLogger?.info(
    { schema_version: 1, event: 'submit_refused', signal, host },
    'submit refused',
  );
  return {
    ok: false,
    errorCode: 'SUBMIT_FORBIDDEN',
    message: renderAgentMessage('tool', 'SUBMIT_FORBIDDEN', signal, { name }),
    retryable: false,
    diagnostic: { cause: signal },
  };
}

/**
 * True when the saved workflow `name`, or any workflow it calls, contains a
 * `click` step — or when that cannot be ruled out (a plan that cannot be
 * loaded, a call without a callee, or more workflows than the check reads).
 * Structural and read-only: nothing runs.
 */
export async function workflowMayClick(
  name: string,
  loadSteps: ((name: string) => Promise<readonly WorkflowStepShape[] | null>) | undefined,
): Promise<boolean> {
  if (loadSteps === undefined) return true;
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > MAX_WORKFLOWS_CHECKED) return true;
    const steps = await loadSteps(next);
    if (steps === null) return true;
    for (const step of steps) {
      if (step.verb === 'click') return true;
      if (step.verb === 'call_workflow') {
        if (step.workflow_name === undefined || step.workflow_name.length === 0) return true;
        queue.push(step.workflow_name);
      }
    }
  }
  return false;
}
