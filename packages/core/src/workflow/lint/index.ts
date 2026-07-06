import type { WorkflowFile } from '@yantra/protocol';

import { criticalActionWithoutConfirmation } from './rules/critical-action-without-confirmation.js';
import { deeplyNestedStep } from './rules/deeply-nested-step.js';
import { jsonataExpressionInvalid } from './rules/jsonata-expression-invalid.js';
import { missingIntentName } from './rules/missing-intent-name.js';
import { mixedExpressionForms } from './rules/mixed-expression-forms.js';
import { noRawCssAtStep } from './rules/no-raw-css-at-step.js';
import { orphanedLocator } from './rules/orphaned-locator.js';
import { outputsUnredactedWithoutReadOnly } from './rules/outputs-unredacted-without-read-only.js';
import { scopeMutatingVerb } from './rules/scope-mutating-verb.js';
import { secretShapedLiteral } from './rules/secret-shaped-literal.js';
import { undeclaredParamRef } from './rules/undeclared-param-ref.js';
import { undeclaredSecretRef } from './rules/undeclared-secret-ref.js';
import { unrecordedFramesOnAuthenticated } from './rules/unrecorded-frames-on-authenticated.js';

export interface LintFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  suggestion: string | null;
}

export interface LintReport {
  errors: LintFinding[];
  warnings: LintFinding[];
  infos: LintFinding[];
}

export interface LintContext {
  strict: boolean;
}

export interface LintRule {
  name: string;
  check(workflow: WorkflowFile, ctx: LintContext): LintFinding[];
}

export interface LintOptions {
  strict?: boolean;
  rules?: LintRule[];
}

const DEFAULT_RULES: LintRule[] = [
  noRawCssAtStep,
  deeplyNestedStep,
  missingIntentName,
  secretShapedLiteral,
  undeclaredSecretRef,
  undeclaredParamRef,
  orphanedLocator,
  jsonataExpressionInvalid,
  scopeMutatingVerb,
  mixedExpressionForms,
  outputsUnredactedWithoutReadOnly,
  unrecordedFramesOnAuthenticated,
  criticalActionWithoutConfirmation,
];

/** Run all lint rules against a workflow. */
export function lint(workflow: WorkflowFile, opts?: LintOptions): LintReport {
  const strict = opts?.strict ?? false;
  const rules = opts?.rules ?? DEFAULT_RULES;
  const ctx: LintContext = { strict };

  const allFindings: LintFinding[] = [];
  for (const rule of rules) {
    const findings = rule.check(workflow, ctx);
    allFindings.push(...findings);
  }

  const report: LintReport = {
    errors: [],
    warnings: [],
    infos: [],
  };

  for (const finding of allFindings) {
    const effectiveSeverity = strict && finding.severity === 'warning' ? 'error' : finding.severity;
    const promoted: LintFinding = { ...finding, severity: effectiveSeverity };
    if (effectiveSeverity === 'error') {
      report.errors.push(promoted);
    } else if (effectiveSeverity === 'warning') {
      report.warnings.push(promoted);
    } else {
      report.infos.push(promoted);
    }
  }

  return report;
}
