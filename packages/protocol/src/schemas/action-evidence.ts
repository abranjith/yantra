/** Stable, value-free evidence for verified browser actions. */
import { z } from 'zod';

import { ArtifactRef } from './artifact-ref.js';

export const ActionId = z
  .string()
  .regex(/^A[1-9]\d*$/u)
  .describe('Run-wide action identifier, equal to A followed by the ledger sequence.');
export type ActionId = z.infer<typeof ActionId>;

// eslint-disable-next-line no-control-regex -- reject raw ANSI escape bytes
const noAnsi = (value: string): boolean => !/[\u001b\u009b]/u.test(value);
const text = (max: number) =>
  z.string().max(max).refine(noAnsi, 'must not contain raw ANSI escape bytes');

export const BriefAction = z
  .object({
    id: ActionId,
    kind: z.enum(['fill', 'click', 'submit_refused', 'capture']).describe('Verified action kind.'),
    label: text(120)
      .nullable()
      .describe('Sanitized field or control label; null when no label is known.'),
    label_origin: z
      .enum(['explicit', 'structural', 'placeholder', 'title', 'none'])
      .optional()
      .describe('Evidence from which the fill label was resolved.'),
    confidence: z
      .enum(['high', 'medium', 'low'])
      .optional()
      .describe('Confidence of an inferred label.'),
    section: text(60).optional().describe('Sanitized form section containing the field.'),
    ref: z
      .string()
      .regex(/^e[0-9]+$/u)
      .optional()
      .describe('Page-scoped target reference.'),
    epoch: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Committed document epoch when the action happened.'),
    call_id: z
      .string()
      .min(1)
      .refine(noAnsi)
      .nullable()
      .describe('Provider tool-call identifier, or null for a direct execution.'),
    host: z
      .string()
      .refine(noAnsi)
      .nullable()
      .describe('Page hostname at action time, or null when unknown.'),
    verification: z
      .union([
        z
          .object({
            resolution: z
              .enum([
                'exact',
                'single_offered_match',
                'selected_from_offered',
                'typed_literal',
                'reformatted',
              ])
              .describe('How the fill was verified.'),
          })
          .strict(),
        z
          .object({
            withheld: z
              .object({
                reason: z
                  .enum(['password', 'autocomplete', 'secret_marker', 'stored_secret'])
                  .describe(
                    'Why the readback was withheld, including an opaque stored-secret fill.',
                  ),
                verdict: z
                  .enum(['exact', 'reformatted', 'unchecked'])
                  .describe('Safe comparison verdict; never the protected value.'),
              })
              .strict()
              .describe('Protected readback verification.'),
          })
          .strict(),
      ])
      .optional()
      .describe('Fill verification without any committed value.'),
    signal: z
      .enum(['structural', 'name', 'nested-workflow'])
      .optional()
      .describe('Signal that caused a submit refusal.'),
    artifacts: z
      .array(ArtifactRef)
      .min(1)
      .max(6)
      .optional()
      .describe('Every saved file of a capture action.'),
  })
  .strict()
  .superRefine((action, ctx) => {
    for (const [key, kind] of [
      ['verification', 'fill'],
      ['label_origin', 'fill'],
      ['confidence', 'fill'],
      ['signal', 'submit_refused'],
      ['artifacts', 'capture'],
    ] as const) {
      if (action[key] !== undefined && action.kind !== kind)
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is valid only for ${kind}` });
    }
    if (
      action.confidence !== undefined &&
      !['structural', 'placeholder', 'title'].includes(action.label_origin ?? '')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'Confidence is only for inferred labels',
      });
  })
  .describe(
    'One cited, verified browser action: identities and verdicts only, never field values.',
  );

export type BriefAction = z.infer<typeof BriefAction>;
