import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const READ_ONLY_ALLOWED_VERBS = new Set(['extract', 'wait_for', 'llm_summarize']);

export const scopeMutatingVerb: LintRule = {
  name: 'ScopeMutatingVerbInReadOnlyData',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const workflowIsReadOnly = workflow.security_class === 'read-only-data';

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step) continue;

      const effectiveScope = step.scope ?? (workflowIsReadOnly ? 'read-only-data' : null);

      if (effectiveScope === 'read-only-data' && !READ_ONLY_ALLOWED_VERBS.has(step.verb)) {
        findings.push({
          code: 'ScopeMutatingVerbInReadOnlyData',
          severity: 'error',
          path: `steps[${i}]`,
          message: `Step "${step.id}" (verb: ${step.verb}) is a mutating verb but has scope "read-only-data".`,
          suggestion: `Only extract, wait_for, and llm_summarize are allowed in read-only-data scope. Remove scope override or change the verb.`,
        });
      }
    }

    return findings;
  },
};
