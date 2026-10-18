import { z } from 'zod';

import { ArtifactRef } from './artifact-ref.js';

const UtcTimestamp = z
  .string()
  .datetime()
  .refine((value) => value.endsWith('Z'), 'Timestamp must be expressed in UTC with a Z suffix.');

/** One stable Yantra projection of a provider tool lifecycle event. */
export const ToolAuditEntry = z
  .object({
    ts: UtcTimestamp.describe('ISO-8601 UTC timestamp for this lifecycle phase.'),
    seq: z.number().int().nonnegative().describe('Monotonic sequence number within the run.'),
    run_id: z.string().min(1).describe('Owning Yantra run identifier.'),
    session_id: z.string().min(1).describe('Owning provider session identifier.'),
    call_id: z.string().min(1).describe('Provider tool-call identifier pairing start and end.'),
    tool: z.string().min(1).describe('Stable registered tool name.'),
    phase: z.enum(['start', 'end']).describe('Tool-call lifecycle phase.'),
    input_sanitized: z
      .unknown()
      .nullable()
      .describe('Sanitized tool input, or null on end entries.'),
    output_sanitized: z
      .unknown()
      .nullable()
      .describe('Sanitized tool output, or null on start entries.'),
    status: z
      .enum(['ok', 'error', 'denied', 'aborted'])
      .nullable()
      .describe('Terminal tool status, or null on start entries.'),
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Elapsed tool time in milliseconds, or null on start entries.'),
    error_code: z
      .string()
      .min(1)
      .nullable()
      .describe('Stable error code when present, otherwise null.'),
    confirmation_id: z
      .string()
      .min(1)
      .nullable()
      .describe('Linked confirmation identifier when present, otherwise null.'),
    captures: z
      .array(
        z
          .object({
            path: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            mime_type: z.literal('image/png'),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional()
      .describe(
        'Legacy Vision Assist capture metadata written before FEAT-058; read through artifactRefsOf. Never image bytes or a data URI.',
      ),
    artifacts: z
      .array(ArtifactRef)
      .optional()
      .describe(
        'Files this call wrote to the run directory (FEAT-058); metadata only, never image bytes or a data URI.',
      ),
  })
  .strict()
  .describe('Stable append-only tool lifecycle entry stored in tool-calls.jsonl.');

export type ToolAuditEntry = z.infer<typeof ToolAuditEntry>;
