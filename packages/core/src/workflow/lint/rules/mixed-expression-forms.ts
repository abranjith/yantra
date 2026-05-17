import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

const EXPRESSION_PATTERN = /\{\{(.+?)\}\}/g;

function isOpaqueRef(content: string): boolean {
  return /^(secret|param|capture):[a-z0-9_.-]+$/.test(content.trim());
}

function hasMixedExpressions(value: string): boolean {
  const re = new RegExp(EXPRESSION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  let hasOpaque = false;
  let hasJsonata = false;

  while ((match = re.exec(value)) !== null) {
    const content = match[1];
    if (!content) continue;
    if (isOpaqueRef(content.trim())) {
      hasOpaque = true;
    } else {
      hasJsonata = true;
    }
  }

  return hasOpaque && hasJsonata;
}

function isOpaqueRefWithJsonataInside(value: string): boolean {
  const re = new RegExp(EXPRESSION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = re.exec(value)) !== null) {
    const content = match[1];
    if (!content) continue;
    const trimmed = content.trim();
    // Trips when an expression starts as an opaque ref (`secret:`, `param:`, `capture:`)
    // but contains JSONata-shaped trailing characters (pipes, dollars, parens) that
    // the resolver can't evaluate as a pure ref.
    if (/^(secret|param|capture):/.test(trimmed) && !isOpaqueRef(trimmed)) {
      return true;
    }
  }

  return false;
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

export const mixedExpressionForms: LintRule = {
  name: 'MixedExpressionForms',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];
    const candidates = collectAllStringValues(workflow);

    for (const { path, value } of candidates) {
      if (hasMixedExpressions(value) || isOpaqueRefWithJsonataInside(value)) {
        findings.push({
          code: 'MixedExpressionForms',
          severity: 'error',
          path,
          message: `Value at "${path}" mixes opaque refs (secret/param/capture) with JSONata expressions in the same string.`,
          suggestion:
            'Use only one expression form per value. Separate mixed logic into a JSONata expression or use a param.',
        });
      }
    }

    return findings;
  },
};
