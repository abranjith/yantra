import { z } from 'zod';

import { JsonValue } from '../commands/schema.js';

const failureExit = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(130),
]);
/** Final worker completion; cancellation preserves the CLI's exit code 130. */
export const CommandResultMessageSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('result'),
        exit_code: z.union([z.literal(0), failureExit]),
        envelope: JsonValue.nullable().describe('The final terminal JSON envelope, when emitted.'),
        text: z
          .string()
          .nullable()
          .describe('Human output capped at 64 KiB including a truncation marker.'),
      })
      .strict(),
    z
      .object({
        type: z.literal('error'),
        exit_code: failureExit,
        code: z.string().min(1),
        message: z.string(),
        remediation: z.string().nullable(),
      })
      .strict(),
  ])
  .describe('The final completion of a command executed on a worker surface.');
export type CommandResultMessage = z.infer<typeof CommandResultMessageSchema>;
