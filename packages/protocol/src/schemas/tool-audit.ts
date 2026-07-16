import { z } from 'zod';

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
  })
  .strict()
  .describe('Stable append-only tool lifecycle entry stored in tool-calls.jsonl.');

export type ToolAuditEntry = z.infer<typeof ToolAuditEntry>;
