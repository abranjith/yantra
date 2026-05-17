import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const PARAM_REF_PATTERN = /\{\{\s*param:([a-z0-9_]+)\s*\}\}/g;

function extractParamRefs(value: string): string[] {
  const refs: string[] = [];
  const re = new RegExp(PARAM_REF_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const key = match[1];
    if (key) refs.push(key);
  }
  return refs;
}

function collectAllStringValues(workflow: WorkflowFile): { path: string; value: string }[] {
  const results: { path: string; value: string }[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    if (step.verb === 'fill' && typeof step.value === 'string') {
      results.push({ path: `steps[${i}].value`, value: step.value });
    }
    if (step.verb === 'navigate' && typeof step.url === 'string') {
      results.push({ path: `steps[${i}].url`, value: step.url });
    }
    if (step.verb === 'call_workflow') {
      for (const [k, v] of Object.entries(step.params)) {
        if (typeof v === 'string') {
          results.push({ path: `steps[${i}].params.${k}`, value: v });
        }
      }
    }
  }

  for (let i = 0; i < workflow.outputs.length; i++) {
    const output = workflow.outputs[i];
    if (output) {
      results.push({ path: `outputs[${i}].from`, value: output.from });
    }
  }

  return results;
}

export const undeclaredParamRef: LintRule = {
  name: 'UndeclaredParamRef',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const declaredParams = new Set(Object.keys(workflow.params));
    const candidates = collectAllStringValues(workflow);

    for (const { path, value } of candidates) {
      const refs = extractParamRefs(value);
      for (const ref of refs) {
        if (!declaredParams.has(ref)) {
          findings.push({
            code: 'UndeclaredParamRef',
            severity: 'error',
            path,
            message: `Param ref "{{ param:${ref} }}" is not declared in the workflow's params.`,
            suggestion: `Add "${ref}" to the params section at the top of the workflow.`,
          });
        }
      }
    }

    return findings;
  },
};
