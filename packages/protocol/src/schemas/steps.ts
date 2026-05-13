import { z } from 'zod';

import { CaptureRef, LocatorChain, ParamRef, ValueRef } from './refs.js';
import { SecurityScope } from './security.js';

const STEP_ID_PATTERN = /^s[0-9]+$/;
const CAPTURE_ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/;

export const StepHeader = {
  id: z.string().regex(STEP_ID_PATTERN).describe('Step identifier, unique within the plan.'),
  scope: SecurityScope.nullable().describe('Step scope; null inherits the plan default.'),
} as const;

export const PrimitiveExtractionKind = z
  .enum(['string', 'number', 'boolean', 'date', 'money'])
  .describe('Primitive extraction output kind.');

export const ExtractionSchema: z.ZodType<
  | { type: 'primitive'; kind: z.infer<typeof PrimitiveExtractionKind> }
  | { type: 'array'; items: z.infer<typeof ExtractionSchema> }
  | { type: 'object'; fields: Record<string, z.infer<typeof ExtractionSchema>> }
> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('primitive').describe('Primitive extraction schema node.'),
      kind: PrimitiveExtractionKind.describe('Primitive value kind.'),
    }),
    z.object({
      type: z.literal('array').describe('Array extraction schema node.'),
      items: z.lazy(() => ExtractionSchema).describe('Item schema for extracted arrays.'),
    }),
    z.object({
      type: z.literal('object').describe('Object extraction schema node.'),
      fields: z
        .record(
          z.string(),
          z.lazy(() => ExtractionSchema),
        )
        .describe('Field mapping for extracted object rows.'),
    }),
  ]),
);

export type ExtractionSchema = z.infer<typeof ExtractionSchema>;

export const AssertCondition = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('visible').describe('Assert that target is visible.'),
    }),
    z.object({
      kind: z.literal('hidden').describe('Assert that target is hidden.'),
    }),
    z.object({
      kind: z.literal('text_matches').describe('Assert text by regex pattern.'),
      pattern: z.string().describe('Regular expression source.'),
      flags: z.string().default('').describe('Regex flags.'),
    }),
    z.object({
      kind: z.literal('count_equals').describe('Assert list count equals expected value.'),
      count: z.number().int().nonnegative().describe('Expected count.'),
    }),
  ])
  .describe('Assertion condition payload.');

export type AssertCondition = z.infer<typeof AssertCondition>;

export const BranchCondition = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('always').describe('Always branch to then_step_id.') }),
    z.object({
      kind: z.literal('capture_exists').describe('Branch if capture reference resolves.'),
      capture: CaptureRef.describe('Capture checked for branch decision.'),
    }),
  ])
  .describe('Branch condition expression.');

export type BranchCondition = z.infer<typeof BranchCondition>;

export const ClickModifiers = z
  .object({
    alt: z.boolean().default(false).describe('Alt modifier key.'),
    shift: z.boolean().default(false).describe('Shift modifier key.'),
    ctrl: z.boolean().default(false).describe('Control modifier key.'),
    meta: z.boolean().default(false).describe('Meta modifier key.'),
  })
  .describe('Optional keyboard modifiers for click steps.');

export type ClickModifiers = z.infer<typeof ClickModifiers>;

export const NavigateStep = z
  .object({
    ...StepHeader,
    type: z.literal('navigate').describe('Navigate step discriminator.'),
    url: ValueRef.describe('Target URL as a value reference.'),
  })
  .describe('Navigate browser to a URL.');

export const ClickStep = z
  .object({
    ...StepHeader,
    type: z.literal('click').describe('Click step discriminator.'),
    locator: LocatorChain.describe('Locator chain for click target.'),
    modifiers: ClickModifiers.nullable().describe('Optional click modifier keys.'),
  })
  .describe('Click on a resolved locator target.');

export const FillStep = z
  .object({
    ...StepHeader,
    type: z.literal('fill').describe('Fill step discriminator.'),
    locator: LocatorChain.describe('Locator chain for fill target.'),
    value: ValueRef.describe('Value inserted into the target input.'),
    submit: z.boolean().default(false).describe('Whether to submit after filling.'),
  })
  .describe('Fill an input-like field.');

export const ExtractStep = z
  .object({
    ...StepHeader,
    type: z.literal('extract').describe('Extract step discriminator.'),
    locator: LocatorChain.describe('Locator chain for extraction target.'),
    extraction_schema: ExtractionSchema.describe('Expected extracted data shape.'),
    capture_as: z
      .string()
      .regex(CAPTURE_ALIAS_PATTERN)
      .describe('Capture alias for downstream references.'),
  })
  .describe('Extract data from the page using a declared schema.');

export const WaitForStep = z
  .object({
    ...StepHeader,
    type: z.literal('wait_for').describe('Wait-for step discriminator.'),
    locator: LocatorChain.describe('Locator chain for awaited target.'),
    state: z
      .enum(['visible', 'hidden', 'attached', 'detached'])
      .describe('Target state to wait for.'),
    timeout_ms: z.number().int().positive().nullable().describe('Optional timeout override.'),
  })
  .describe('Wait for target element state transitions.');

export const AssertStep = z
  .object({
    ...StepHeader,
    type: z.literal('assert').describe('Assert step discriminator.'),
    locator: LocatorChain.describe('Locator chain for assertion target.'),
    condition: AssertCondition.describe('Assertion condition payload.'),
  })
  .describe('Assert state against the current page.');

export const BranchStep = z
  .object({
    ...StepHeader,
    type: z.literal('branch').describe('Branch step discriminator.'),
    condition: BranchCondition.describe('Branch condition payload.'),
    then_step_id: z.string().regex(STEP_ID_PATTERN).describe('Step id for true branch.'),
    else_step_id: z
      .string()
      .regex(STEP_ID_PATTERN)
      .nullable()
      .describe('Optional step id for false branch.'),
  })
  .describe('Explicit branch to another step id.');

export const LoopStep = z
  .object({
    ...StepHeader,
    type: z.literal('loop').describe('Loop step discriminator.'),
    over: z.union([CaptureRef, ParamRef]).describe('Collection reference iterated by loop.'),
    as: z.string().regex(CAPTURE_ALIAS_PATTERN).describe('Loop variable alias.'),
    body_step_ids: z
      .array(z.string().regex(STEP_ID_PATTERN))
      .min(1)
      .describe('Step ids that form the loop body.'),
    max_iterations: z
      .number()
      .int()
      .positive()
      .describe('Hard cap for loop iterations at runtime.'),
  })
  .describe('Iterate over collection values.');

export const CallWorkflowStep = z
  .object({
    ...StepHeader,
    type: z.literal('call_workflow').describe('Call-workflow step discriminator.'),
    workflow_name: z.string().min(1).describe('Name of workflow to invoke.'),
    params: z
      .record(z.string(), ValueRef)
      .default({})
      .describe('Param values passed to called workflow.'),
    capture_as: z
      .string()
      .regex(CAPTURE_ALIAS_PATTERN)
      .nullable()
      .describe('Optional capture alias for workflow output.'),
  })
  .describe('Invoke another workflow from the current plan.');

export const LLMSummarizeStep = z
  .object({
    ...StepHeader,
    type: z.literal('llm_summarize').describe('LLM summarize step discriminator.'),
    input: CaptureRef.describe('Capture reference fed to summarization.'),
    prompt: z.string().min(1).describe('Summarization instruction prompt.'),
    output_as: z
      .string()
      .regex(CAPTURE_ALIAS_PATTERN)
      .describe('Capture alias for summarization output.'),
  })
  .describe('Summarize extracted captures with an LLM.');

export const Step = z
  .discriminatedUnion('type', [
    NavigateStep,
    ClickStep,
    FillStep,
    ExtractStep,
    WaitForStep,
    AssertStep,
    BranchStep,
    LoopStep,
    CallWorkflowStep,
    LLMSummarizeStep,
  ])
  .describe('Single executable unit in a validated plan.');

export type NavigateStep = z.infer<typeof NavigateStep>;
export type ClickStep = z.infer<typeof ClickStep>;
export type FillStep = z.infer<typeof FillStep>;
export type ExtractStep = z.infer<typeof ExtractStep>;
export type WaitForStep = z.infer<typeof WaitForStep>;
export type AssertStep = z.infer<typeof AssertStep>;
export type BranchStep = z.infer<typeof BranchStep>;
export type LoopStep = z.infer<typeof LoopStep>;
export type CallWorkflowStep = z.infer<typeof CallWorkflowStep>;
export type LLMSummarizeStep = z.infer<typeof LLMSummarizeStep>;
export type Step = z.infer<typeof Step>;
