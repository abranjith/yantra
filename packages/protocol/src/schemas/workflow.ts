import { z } from 'zod';

import { ConsequenceLevel, ExpectedCost } from './confirmation.js';
import { RoleEnum } from './refs.js';
import { SecurityClass, SecurityScope } from './security.js';
import { AssertCondition, ExtractionSchema } from './steps.js';

const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const OUTPUT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SECRET_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const STEP_ID_PATTERN = /^s[0-9]+$/;

/** Workflow verbs that may carry `requires_confirmation`. */
const CONFIRMABLE_WORKFLOW_VERBS = new Set(['navigate', 'click', 'fill']);

/**
 * Optional confirmation annotations for workflow steps — mirrors the
 * protocol `ConfirmationAnnotations` on `steps.ts`. These enrich the
 * consent card when a step is flagged `requires_confirmation`.
 */
const WorkflowConfirmationAnnotations = {
  confirmation_description: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe('Human-readable override for the consent card. Falls back to step name when null.'),
  expected_cost: ExpectedCost.nullable()
    .default(null)
    .describe('Best-effort cost estimate shown on the consent card, or null if unknown.'),
  consequence: ConsequenceLevel.nullable()
    .default(null)
    .describe('Reversibility hint for the action, or null to default to "unknown".'),
} as const;

export const RegexShape = z
  .object({
    pattern: z.string().describe('Regex source pattern.'),
    flags: z.string().default('').describe('Regex flags string.'),
  })
  .describe('Regex descriptor for workflow locator names.');

export type RegexShape = z.infer<typeof RegexShape>;

export const LocatorCandidate = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('role').describe('ARIA role candidate.'),
      role: RoleEnum.describe('ARIA role name.'),
      name: z.union([z.string(), RegexShape]).describe('Accessible name matcher.'),
    }),
    z.object({
      kind: z.literal('testid').describe('data-testid candidate.'),
      value: z.string().describe('Test id value.'),
    }),
    z.object({
      kind: z.literal('label').describe('Label-text candidate.'),
      value: z.string().describe('Label text value.'),
    }),
    z.object({
      kind: z.literal('placeholder').describe('Placeholder candidate.'),
      value: z.string().describe('Placeholder text value.'),
    }),
    z.object({
      kind: z.literal('css').describe('CSS selector candidate.'),
      value: z.string().describe('CSS selector value.'),
    }),
    z.object({
      kind: z.literal('xpath').describe('XPath selector candidate.'),
      value: z.string().describe('XPath selector value.'),
    }),
  ])
  .describe('Candidate locator entry in workflow _locators block.');

export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const ParamDeclaration = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'date']).describe('Declared param scalar type.'),
    example: z.string().nullable().default(null).describe('Optional example value.'),
    required: z.boolean().default(true).describe('Whether the param is required.'),
  })
  .describe('Workflow parameter declaration.');

export type ParamDeclaration = z.infer<typeof ParamDeclaration>;

export const WorkflowValueExpression = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe('Workflow value expression or scalar literal.');

const WorkflowStepBase = {
  id: z.string().regex(STEP_ID_PATTERN).describe('Workflow step id.'),
  scope: SecurityScope.nullable().describe('Optional step scope override.'),
  requires_confirmation: z
    .boolean()
    .default(false)
    .describe(
      'If true, the executor pauses for human consent before executing this step. Only legal on click, fill, and navigate steps.',
    ),
} as const;

export const WorkflowStep = z
  .discriminatedUnion('verb', [
    z.object({
      ...WorkflowStepBase,
      ...WorkflowConfirmationAnnotations,
      verb: z.literal('navigate').describe('Navigate workflow step.'),
      url: WorkflowValueExpression.describe('URL value or template expression.'),
    }),
    z.object({
      ...WorkflowStepBase,
      ...WorkflowConfirmationAnnotations,
      verb: z.literal('click').describe('Click workflow step.'),
      locator: z.string().min(1).describe('Named locator key from _locators.'),
    }),
    z.object({
      ...WorkflowStepBase,
      ...WorkflowConfirmationAnnotations,
      verb: z.literal('fill').describe('Fill workflow step.'),
      locator: z.string().min(1).describe('Named locator key from _locators.'),
      value: WorkflowValueExpression.describe('Fill value or template expression.'),
      submit: z.boolean().default(false).describe('Whether to submit after fill.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('extract').describe('Extract workflow step.'),
      locator: z.string().min(1).describe('Named locator key from _locators.'),
      extraction_schema: ExtractionSchema.describe('Declared extraction schema.'),
      capture_as: z
        .string()
        .regex(OUTPUT_NAME_PATTERN)
        .describe('Capture alias for extracted data.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('wait_for').describe('Wait-for workflow step.'),
      locator: z.string().min(1).describe('Named locator key from _locators.'),
      state: z
        .enum(['visible', 'hidden', 'attached', 'detached'])
        .describe('Awaited target state.'),
      timeout_ms: z.number().int().positive().nullable().describe('Optional timeout override.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('assert').describe('Assert workflow step.'),
      locator: z.string().min(1).describe('Named locator key from _locators.'),
      condition: AssertCondition.describe('Assertion condition payload.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('branch').describe('Branch workflow step.'),
      condition: z.string().min(1).describe('Branch expression or symbolic condition id.'),
      then_step_id: z.string().regex(STEP_ID_PATTERN).describe('Step id for true branch.'),
      else_step_id: z
        .string()
        .regex(STEP_ID_PATTERN)
        .nullable()
        .describe('Optional step id for false branch.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('loop').describe('Loop workflow step.'),
      over: z.string().min(1).describe('Collection expression for loop iteration.'),
      as: z.string().regex(PARAM_KEY_PATTERN).describe('Loop variable alias.'),
      body_step_ids: z
        .array(z.string().regex(STEP_ID_PATTERN))
        .min(1)
        .describe('Loop body step ids.'),
      max_iterations: z.number().int().positive().describe('Maximum loop iterations.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('call_workflow').describe('Call-workflow workflow step.'),
      workflow_name: z.string().min(1).describe('Workflow name to invoke.'),
      params: z
        .record(z.string(), WorkflowValueExpression)
        .default({})
        .describe('Workflow call param mapping.'),
      capture_as: z
        .string()
        .regex(OUTPUT_NAME_PATTERN)
        .nullable()
        .describe('Optional capture alias for workflow call output.'),
    }),
    z.object({
      ...WorkflowStepBase,
      verb: z.literal('llm_summarize').describe('LLM summarize workflow step.'),
      input: z.string().min(1).describe('Capture expression for summarization input.'),
      prompt: z.string().min(1).describe('Summarization prompt template.'),
      output_as: z
        .string()
        .regex(OUTPUT_NAME_PATTERN)
        .describe('Capture alias for summary output.'),
    }),
  ])
  .refine(
    (step) => !step.requires_confirmation || CONFIRMABLE_WORKFLOW_VERBS.has(step.verb),
    (step) => ({
      message: `requires_confirmation is not legal on "${step.verb}" steps — only click, fill, and navigate may require confirmation.`,
      path: ['requires_confirmation'],
    }),
  )
  .describe('Workflow-friendly step union mirroring protocol step verbs.');

export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowOutput = z
  .object({
    name: z.string().regex(OUTPUT_NAME_PATTERN).describe('Workflow output key.'),
    from: z.string().min(1).describe('Template expression sourcing output value.'),
  })
  .describe('Workflow output binding.');

export type WorkflowOutput = z.infer<typeof WorkflowOutput>;

/**
 * Optional post-execution synthesis intent (FEAT-FP-001).
 *
 * Declaring this block asks `yantra run` to turn the run's recorded source
 * reads into a Brief (`brief.json` / `brief.md` / `brief.html`) after the last
 * step. It is a declared, validated leaf of a finite plan — it never influences
 * which steps run, so replay stays deterministic in shape whether or not a model
 * is involved in the wording.
 */
export const WorkflowSynthesis = z
  .object({
    goal: z
      .string()
      .min(1)
      .max(512)
      .describe('The question or topic the synthesized Brief must answer.'),
    length: z
      .enum(['short', 'medium', 'long'])
      .default('medium')
      .describe('Findings/sections budget for the Brief: short=3, medium=6, long=10 findings.'),
    detail: z
      .enum(['overview', 'standard', 'full'])
      .default('standard')
      .describe(
        'Brief depth: overview omits sections, standard adds them, full adds comparison facets.',
      ),
  })
  .describe('Optional post-execution synthesis intent producing a Brief from recorded reads.');

export type WorkflowSynthesis = z.infer<typeof WorkflowSynthesis>;

export const WorkflowFile = z
  .object({
    version: z.literal(1).describe('Workflow format major version.'),
    name: z.string().regex(WORKFLOW_NAME_PATTERN).describe('Workflow slug name.'),
    description: z.string().nullable().describe('Optional workflow description.'),
    security_class: SecurityClass.default('public').describe('Workflow security class.'),
    recorded_with: z
      .object({
        chrome_major: z
          .number()
          .int()
          .positive()
          .describe('Chrome major version used at recording time.'),
        yantra_version: z.string().min(1).describe('Yantra version used at recording time.'),
      })
      .nullable()
      .default(null)
      .describe('Optional recording metadata.'),
    params: z
      .record(z.string().regex(PARAM_KEY_PATTERN), ParamDeclaration)
      .default({})
      .describe('Workflow parameter declarations.'),
    secrets: z
      .array(z.string().regex(SECRET_KEY_PATTERN))
      .default([])
      .describe('Declared workflow secret keys.'),
    cookies: z.enum(['auto', 'none']).default('none').describe('Cookie/profile handling mode.'),
    steps: z.array(WorkflowStep).min(1).max(64).describe('Ordered workflow steps.'),
    outputs: z.array(WorkflowOutput).default([]).describe('Workflow output declarations.'),
    synthesis: WorkflowSynthesis.nullable()
      .default(null)
      .describe(
        'Optional post-execution synthesis intent; null (the default) means the run reports its declared outputs only.',
      ),
    outputs_unredacted: z
      .boolean()
      .default(false)
      .describe('Whether outputs bypass redaction safeguards.'),
    _unrecorded_frames: z
      .array(z.string())
      .default([])
      .describe('Cross-origin frames not instrumented at record time.'),
    _locators: z
      .record(z.string().min(1), z.array(LocatorCandidate))
      .default({})
      .describe('Named locator chains captured or authored for replay.'),
  })
  .describe('Workflow YAML schema source used by parser, linter, and editor integrations.');

export type WorkflowFile = z.infer<typeof WorkflowFile>;
