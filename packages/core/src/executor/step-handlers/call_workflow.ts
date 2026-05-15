import type { CallWorkflowStep } from '@yantra/protocol';

import type { StepHandler, StepResult } from '../types.js';

/**
 * CallWorkflow step handler — stub implementation.
 *
 * Full implementation requires FEAT-010 (WorkflowStore + workflow YAML loading).
 * Until FEAT-010 ships, this handler returns a structured failure so the dispatch
 * path is exercised by tests while the verb is effectively disabled.
 */
export const handleCallWorkflow: StepHandler<CallWorkflowStep> = (
  step,
  _ctx,
): Promise<StepResult> => {
  return Promise.resolve({
    kind: 'failed',
    failureClass: 'unexpected',
    error: new Error(
      `call_workflow step "${step.id}" (workflow: "${step.workflow_name}") requires FEAT-010. ` +
        'Wire a WorkflowStore into ExecutionContext to enable cross-workflow calls.',
    ),
  });
};
