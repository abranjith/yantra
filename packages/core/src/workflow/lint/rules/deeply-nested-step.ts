import type { WorkflowFile, WorkflowStep } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const MAX_DEPTH = 3;

function computeMaxNestingDepth(steps: WorkflowStep[]): number {
  const stepById = new Map<string, WorkflowStep>();
  for (const step of steps) {
    stepById.set(step.id, step);
  }

  function depthFrom(stepId: string, visited: Set<string>): number {
    if (visited.has(stepId)) return 0;
    visited.add(stepId);
    const step = stepById.get(stepId);
    if (!step) return 0;

    if (step.verb === 'branch') {
      const thenDepth = depthFrom(step.then_step_id, new Set(visited));
      const elseDepth = step.else_step_id ? depthFrom(step.else_step_id, new Set(visited)) : 0;
      return 1 + Math.max(thenDepth, elseDepth);
    }

    if (step.verb === 'loop') {
      let maxBodyDepth = 0;
      for (const bodyId of step.body_step_ids) {
        const d = depthFrom(bodyId, new Set(visited));
        if (d > maxBodyDepth) maxBodyDepth = d;
      }
      return 1 + maxBodyDepth;
    }

    return 1;
  }

  let max = 0;
  for (const step of steps) {
    if (step.verb === 'branch' || step.verb === 'loop') {
      const d = depthFrom(step.id, new Set());
      if (d > max) max = d;
    }
  }
  return max;
}

export const deeplyNestedStep: LintRule = {
  name: 'DeeplyNestedStep',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const depth = computeMaxNestingDepth(workflow.steps);

    if (depth > MAX_DEPTH) {
      findings.push({
        code: 'DeeplyNestedStep',
        severity: 'warning',
        path: 'steps',
        message: `Workflow has branch/loop nesting depth of ${depth}, which exceeds the maximum of ${MAX_DEPTH}.`,
        suggestion:
          'Consider extracting deeply nested logic into a separate workflow using call_workflow.',
      });
    }

    return findings;
  },
};
