import { z } from 'zod';

/**
 * The run's two capture capabilities (FEAT-058), resolved before the first
 * tool call and recorded in the manifest and `run-health.json`:
 *
 * - **Vision Assist** (`browser_screenshot`): pixels go to the model, behind
 *   a stored grant, an image-capable model, browser tools, no
 *   `--no-screenshots`, and a non-zero-LLM context.
 * - **Deliverable capture** (`browser_capture`): a clean PNG kept on this
 *   computer, available whenever the run has a browser with interaction
 *   tools and `--no-screenshots` is absent.
 *
 * Each records every failing condition as a closed reason code, so a run
 * without a capture tool says which gate kept it off.
 */

/** Why Vision Assist is off, in a fixed order. */
export const VisionAssistReason = z
  .enum([
    'grant_missing',
    'model_no_image_input',
    'no_browser_tools',
    'suppressed_by_flag',
    'zero_llm',
  ])
  .describe('A condition that keeps Vision Assist off.');

export type VisionAssistReason = z.infer<typeof VisionAssistReason>;

/** Why deliverable capture is off, in a fixed order. */
export const DeliverableCaptureReason = z
  .enum(['suppressed_by_flag', 'no_browser', 'no_interaction_tools'])
  .describe('A condition that keeps deliverable capture off.');

export type DeliverableCaptureReason = z.infer<typeof DeliverableCaptureReason>;

/** `reasons` is empty exactly when the capability is available. */
function capabilityDecision<T extends z.ZodTypeAny>(reason: T, description: string) {
  return z
    .object({
      available: z.boolean().describe('Whether the capability is registered for this run.'),
      reasons: z
        .array(reason)
        .describe('Every condition that keeps it off; empty exactly when available.'),
    })
    .strict()
    .superRefine((decision, ctx) => {
      if (decision.available && decision.reasons.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reasons'],
          message: 'an available capability must have no reasons',
        });
      }
      if (!decision.available && decision.reasons.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reasons'],
          message: 'an unavailable capability must name at least one reason',
        });
      }
    })
    .describe(description);
}

export const VisionAssistCapability = capabilityDecision(
  VisionAssistReason,
  'Whether Vision Assist (screenshots sent to the model) is available, and why not.',
);

export type VisionAssistCapability = z.infer<typeof VisionAssistCapability>;

export const DeliverableCaptureCapability = capabilityDecision(
  DeliverableCaptureReason,
  'Whether deliverable capture (screenshots kept on this computer) is available, and why not.',
);

export type DeliverableCaptureCapability = z.infer<typeof DeliverableCaptureCapability>;

export const CaptureCapabilityRecord = z
  .object({
    vision_assist: VisionAssistCapability,
    deliverable: DeliverableCaptureCapability,
  })
  .strict()
  .describe("The run's two capture capabilities, resolved before the first tool call.");

export type CaptureCapabilityRecord = z.infer<typeof CaptureCapabilityRecord>;
