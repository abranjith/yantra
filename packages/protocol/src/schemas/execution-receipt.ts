import { z } from 'zod';

import { isAbsoluteCwd } from '../commands/invocation.js';
import { JsonValue } from '../commands/schema.js';

const absolutePath = z.string().refine(isAbsoluteCwd, 'Path must be absolute');
export const SettingSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('flag') }).strict(),
    z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
    z.object({ kind: z.literal('preference'), key: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('config'), key: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('schedule') }).strict(),
    z.object({ kind: z.literal('workflow') }).strict(),
    z.object({ kind: z.literal('default') }).strict(),
  ])
  .describe('The source of an effective non-secret setting; environment names only.');
export type SettingSource = z.infer<typeof SettingSourceSchema>;
export const ContentIdentitySchema = z
  .object({
    kind: z.enum(['workflow', 'workflow_locators', 'template', 'params_file']),
    path: absolutePath.describe('Absolute path read at invocation start.'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('Streamed SHA-256 of the exact content.'),
  })
  .strict()
  .describe('A content identity at execution start.');
export type ContentIdentity = z.infer<typeof ContentIdentitySchema>;
export const ReceiptSettingSchema = z
  .object({ key: z.string().min(1), value: JsonValue, source: SettingSourceSchema })
  .strict()
  .describe('An effective non-secret setting and its provenance.');
export type ReceiptSetting = z.infer<typeof ReceiptSettingSchema>;
export const ReceiptBrowserSelectionSchema = z
  .object({
    selection: z
      .object({
        source: z.enum(['auto', 'managed', 'system']),
        executablePath: absolutePath.nullable(),
      })
      .strict(),
    source: SettingSourceSchema,
  })
  .strict()
  .describe('Browser selection at start; no profile contents or installation telemetry.');
export type ReceiptBrowserSelection = z.infer<typeof ReceiptBrowserSelectionSchema>;
export const ExecutionReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    written_at: z.string().datetime(),
    yantra_version: z.string().min(1),
    invoked_by: z.enum(['terminal', 'worker', 'daemon']),
    invocation_id: z.string().nullable(),
    command: z.array(z.string().min(1)).nonempty(),
    cwd: absolutePath,
    settings: z
      .array(ReceiptSettingSchema)
      .describe('Effective settings, sorted by key; no secrets or unrelated environment.'),
    content: z.array(ContentIdentitySchema),
    browser: ReceiptBrowserSelectionSchema.nullable(),
  })
  .strict()
  .describe('Immutable execution settings and content identities for one run start or resume.');
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
