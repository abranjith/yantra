import type { WorkflowFile } from '@yantra/protocol';

import { JSONataEvaluator } from '../../yaml/jsonata.js';
import type { LintFinding, LintRule } from '../index.js';

const EXPRESSION_PATTERN = /\{\{(.+?)\}\}/g;

function isOpaqueRef(content: string): boolean {
  return /^(secret|param|capture):[a-z0-9_.-]+$/.test(content.trim());
}

function extractJsonataExpressions(value: string): string[] {
  const exprs: string[] = [];
  const re = new RegExp(EXPRESSION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const content = match[1];
    if (content && !isOpaqueRef(content.trim())) {
      exprs.push(content.trim());
    }
  }
  return exprs;
}

function collectAllStringValues(workflow: WorkflowFile): { path: string; value: string }[] {
  const results: { path: string; value: string }[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    if ((step.verb === 'fill' || step.verb === 'fill_element') && typeof step.value === 'string') {
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
    if (step.verb === 'branch' && typeof step.condition === 'string') {
      results.push({ path: `steps[${i}].condition`, value: step.condition });
    }
    if (step.verb === 'loop' && typeof step.over === 'string') {
      results.push({ path: `steps[${i}].over`, value: step.over });
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

const evaluator = new JSONataEvaluator();

export const jsonataExpressionInvalid: LintRule = {
  name: 'JSONataExpressionInvalid',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const candidates = collectAllStringValues(workflow);

    for (const { path, value } of candidates) {
      const exprs = extractJsonataExpressions(value);
      for (const expr of exprs) {
        const result = evaluator.validate(expr);
        if (!result.isOk) {
          findings.push({
            code: 'JSONataExpressionInvalid',
            severity: 'error',
            path,
            message: `JSONata expression "{{ ${expr} }}" is invalid: ${result.error.message}`,
            suggestion: 'Check the JSONata expression syntax at https://jsonata.org.',
          });
        }
      }
    }

    return findings;
  },
};
