import type { Plan } from '../schemas/plan.js';
import type { LocatorChain, ValueRef } from '../schemas/refs.js';
import { ALLOWED_VERBS_BY_SCOPE } from '../schemas/security.js';
import type { Step } from '../schemas/steps.js';
import type { WorkflowFile, WorkflowStep } from '../schemas/workflow.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';

export interface SemanticValidationContext {
  workflowSecrets?: string[];
  workflowLocators?: string[];
}

export type ValidatedPlan = Plan;
export type ValidatedWorkflow = WorkflowFile;

export class ValidationError extends Error {
  public constructor(
    public readonly path: string,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface ValidationWarning {
  path: string;
  code: string;
  message: string;
}

const collectValueRefs = (value: ValueRef, basePath: string): { ref: ValueRef; path: string }[] => {
  const refs: { ref: ValueRef; path: string }[] = [{ ref: value, path: basePath }];

  if (value.kind === 'template') {
    Object.entries(value.bindings).forEach(([key, nested]) => {
      refs.push(...collectValueRefs(nested, `${basePath}/bindings/${key}`));
    });
  }

  return refs;
};

const collectLocatorChains = (
  locator: LocatorChain,
  basePath: string,
): { locator: LocatorChain; path: string }[] => {
  const entries: { locator: LocatorChain; path: string }[] = [{ locator, path: basePath }];

  if (locator.kind === 'intent' && locator.near !== null) {
    entries.push(...collectLocatorChains(locator.near, `${basePath}/near`));
  }

  return entries;
};

const extractionFieldKeysForStep = (step: Step): string[] => {
  if (step.type !== 'extract') {
    return [];
  }

  if (step.extraction_schema.type !== 'object') {
    return [];
  }

  return Object.keys(step.extraction_schema.fields);
};

const createMissingRefError = (
  path: string,
  code: string,
  value: string,
  domain: string,
): ValidationError => new ValidationError(path, code, `${domain} reference not found: ${value}`);

export const validateSemantics = (
  plan: Plan,
  context: SemanticValidationContext = {},
): Result<ValidatedPlan, ValidationError[]> => {
  const errors: ValidationError[] = [];
  const readOnlyVerbs = new Set<string>(ALLOWED_VERBS_BY_SCOPE['read-only-data']);

  const stepIdToIndex = new Map<string, number>();
  plan.steps.forEach((step, index) => {
    if (stepIdToIndex.has(step.id)) {
      errors.push(
        new ValidationError(
          `/steps/${index}/id`,
          'duplicate_step_id',
          `Duplicate step id ${step.id}.`,
        ),
      );
    } else {
      stepIdToIndex.set(step.id, index);
    }

    const effectiveScope = step.scope ?? plan.default_scope;
    if (effectiveScope === 'read-only-data' && !readOnlyVerbs.has(step.type)) {
      errors.push(
        new ValidationError(
          `/steps/${index}/type`,
          'scope_violation',
          `Step type ${step.type} is not allowed in read-only-data scope.`,
        ),
      );
    }
  });

  const allStepIds = new Set(plan.steps.map((step) => step.id));

  plan.steps.forEach((step, index) => {
    if (step.type === 'branch') {
      if (!allStepIds.has(step.then_step_id)) {
        errors.push(
          createMissingRefError(
            `/steps/${index}/then_step_id`,
            'unknown_then_step',
            step.then_step_id,
            'Branch target step',
          ),
        );
      }

      if (step.else_step_id !== null && !allStepIds.has(step.else_step_id)) {
        errors.push(
          createMissingRefError(
            `/steps/${index}/else_step_id`,
            'unknown_else_step',
            step.else_step_id,
            'Branch else step',
          ),
        );
      }
    }

    if (step.type === 'loop') {
      step.body_step_ids.forEach((bodyStepId, bodyIndex) => {
        if (!allStepIds.has(bodyStepId)) {
          errors.push(
            createMissingRefError(
              `/steps/${index}/body_step_ids/${bodyIndex}`,
              'unknown_loop_body_step',
              bodyStepId,
              'Loop body step',
            ),
          );
        }
      });
    }

    const valueRefs: { ref: ValueRef; path: string }[] = [];
    const locatorRefs: { locator: LocatorChain; path: string }[] = [];

    if (step.type === 'navigate') {
      valueRefs.push(...collectValueRefs(step.url, `/steps/${index}/url`));
    }

    if (step.type === 'fill' || step.type === 'fill_element') {
      valueRefs.push(...collectValueRefs(step.value, `/steps/${index}/value`));
      locatorRefs.push(...collectLocatorChains(step.locator, `/steps/${index}/locator`));
    }

    if (step.type === 'click') {
      locatorRefs.push(...collectLocatorChains(step.locator, `/steps/${index}/locator`));
    }

    if (step.type === 'extract') {
      locatorRefs.push(...collectLocatorChains(step.locator, `/steps/${index}/locator`));
    }

    if (step.type === 'wait_for') {
      locatorRefs.push(...collectLocatorChains(step.locator, `/steps/${index}/locator`));
    }

    if (step.type === 'assert') {
      locatorRefs.push(...collectLocatorChains(step.locator, `/steps/${index}/locator`));
    }

    if (step.type === 'call_workflow') {
      Object.entries(step.params).forEach(([key, value]) => {
        valueRefs.push(...collectValueRefs(value, `/steps/${index}/params/${key}`));
      });
    }

    if (step.type === 'loop' && step.over.kind === 'capture') {
      valueRefs.push({ ref: step.over, path: `/steps/${index}/over` });
    }

    if (step.type === 'llm_summarize') {
      valueRefs.push({ ref: step.input, path: `/steps/${index}/input` });
    }

    if (step.type === 'branch' && step.condition.kind === 'capture_exists') {
      valueRefs.push({ ref: step.condition.capture, path: `/steps/${index}/condition/capture` });
    }

    valueRefs.forEach(({ ref, path }) => {
      if (ref.kind === 'capture') {
        const referencedIndex = stepIdToIndex.get(ref.step_id);
        if (referencedIndex === undefined) {
          errors.push(
            createMissingRefError(path, 'unknown_capture_step', ref.step_id, 'Capture step'),
          );
          return;
        }

        if (referencedIndex >= index) {
          errors.push(
            new ValidationError(
              `${path}/step_id`,
              'capture_must_reference_prior_step',
              `Capture reference ${ref.step_id} must point to a prior step.`,
            ),
          );
          return;
        }

        const producerStep = plan.steps[referencedIndex];
        if (producerStep?.type !== 'extract') {
          errors.push(
            new ValidationError(
              `${path}/step_id`,
              'capture_step_not_extract',
              `Referenced step ${ref.step_id} is not an extract step.`,
            ),
          );
          return;
        }

        if (ref.field !== null) {
          const availableFields = extractionFieldKeysForStep(producerStep);
          if (availableFields.length === 0 || !availableFields.includes(ref.field)) {
            errors.push(
              new ValidationError(
                `${path}/field`,
                'capture_field_missing',
                `Capture field ${ref.field} is not defined by extract schema of ${ref.step_id}.`,
              ),
            );
          }
        }
      }

      if (ref.kind === 'secret' && context.workflowSecrets !== undefined) {
        if (!context.workflowSecrets.includes(ref.key)) {
          errors.push(createMissingRefError(path, 'undeclared_secret', ref.key, 'Secret'));
        }
      }
    });

    locatorRefs.forEach(({ locator, path }) => {
      if (locator.kind === 'workflow' && context.workflowLocators !== undefined) {
        if (!context.workflowLocators.includes(locator.name)) {
          errors.push(
            createMissingRefError(path, 'unknown_locator', locator.name, 'Workflow locator'),
          );
        }
      }
    });
  });

  if (errors.length > 0) {
    return err(errors);
  }

  return ok(plan);
};

const TEMPLATE_REF_PATTERN = /^\{\{\s*(secret|param|capture):([a-z][a-z0-9_.]*)\s*\}\}$/;

const validateWorkflowTemplateRefs = (
  raw: unknown,
  path: string,
  workflow: WorkflowFile,
  errors: ValidationError[],
): void => {
  if (typeof raw !== 'string') {
    return;
  }

  const match = TEMPLATE_REF_PATTERN.exec(raw);
  if (!match) {
    return;
  }

  const kind = match[1];
  const key = match[2] ?? '';

  if (kind === 'secret' && !workflow.secrets.includes(key)) {
    errors.push(createMissingRefError(path, 'undeclared_workflow_secret', key, 'Workflow secret'));
  }

  if (kind === 'param' && !(key in workflow.params)) {
    errors.push(createMissingRefError(path, 'undeclared_workflow_param', key, 'Workflow param'));
  }
};

const getWorkflowStepLocator = (step: WorkflowStep): string | null => {
  switch (step.verb) {
    case 'click':
    case 'fill':
    case 'fill_element':
    case 'extract':
    case 'wait_for':
    case 'assert':
      return step.locator;
    default:
      return null;
  }
};

export const validateWorkflowSemantics = (
  workflow: WorkflowFile,
): {
  result: Result<ValidatedWorkflow, ValidationError[]>;
  warnings: ValidationWarning[];
} => {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const locatorNames = new Set(Object.keys(workflow._locators));

  workflow.steps.forEach((step, index) => {
    const locator = getWorkflowStepLocator(step);
    if (locator !== null && !locatorNames.has(locator)) {
      errors.push(
        new ValidationError(
          `/steps/${index}/locator`,
          'unknown_workflow_locator',
          `Workflow locator ${locator} is not declared in _locators.`,
        ),
      );
    }

    if (step.verb === 'fill' || step.verb === 'fill_element') {
      validateWorkflowTemplateRefs(step.value, `/steps/${index}/value`, workflow, errors);
    }

    if (step.verb === 'navigate') {
      validateWorkflowTemplateRefs(step.url, `/steps/${index}/url`, workflow, errors);
    }

    if (step.verb === 'llm_summarize') {
      validateWorkflowTemplateRefs(step.input, `/steps/${index}/input`, workflow, errors);
    }

    if (step.verb === 'call_workflow') {
      Object.entries(step.params).forEach(([key, value]) => {
        validateWorkflowTemplateRefs(value, `/steps/${index}/params/${key}`, workflow, errors);
      });
    }
  });

  workflow.outputs.forEach((output, index) => {
    validateWorkflowTemplateRefs(output.from, `/outputs/${index}/from`, workflow, errors);
  });

  if (workflow.outputs_unredacted) {
    const hasReadOnlyStep = workflow.steps.some(
      (step) => (step.scope ?? null) === 'read-only-data',
    );
    if (!hasReadOnlyStep) {
      warnings.push({
        path: '/outputs_unredacted',
        code: 'outputs_unredacted_without_read_only_scope',
        message: 'outputs_unredacted is true but no step is marked read-only-data.',
      });
    }
  }

  if (workflow._unrecorded_frames.length > 0 && workflow.security_class !== 'public') {
    warnings.push({
      path: '/_unrecorded_frames',
      code: 'authenticated_unrecorded_frames',
      message: 'Authenticated workflow has unrecorded frames and may miss replay interactions.',
    });
  }

  if (errors.length > 0) {
    return { result: err(errors), warnings };
  }

  return { result: ok(workflow), warnings };
};
