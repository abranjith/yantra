import { z } from 'zod';

export const ExtractionErrorRow = z
  .object({
    __error: z.string().min(1).describe('Coercion failure reason for this row.'),
    __raw: z.unknown().describe('Original raw row payload prior to coercion.'),
  })
  .describe('Row-level extraction error envelope.');

export type ExtractionErrorRow = z.infer<typeof ExtractionErrorRow>;

export const extractionResultEnvelope = <TRow extends z.ZodTypeAny>(rowSchema: TRow) =>
  z
    .object({
      rows: z
        .array(z.union([rowSchema, ExtractionErrorRow]))
        .describe('Extracted rows including per-row error evidence.'),
      metadata: z
        .object({
          total_rows: z.number().int().nonnegative().describe('Total extracted row count.'),
          valid_rows: z.number().int().nonnegative().describe('Count of rows matching row schema.'),
          error_count: z
            .number()
            .int()
            .nonnegative()
            .describe('Count of row-level coercion errors.'),
        })
        .describe('Extraction aggregate metadata.'),
    })
    .superRefine((value, ctx) => {
      if (value.metadata.total_rows !== value.metadata.valid_rows + value.metadata.error_count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metadata', 'total_rows'],
          message: 'total_rows must equal valid_rows + error_count',
        });
      }
    })
    .describe('Lenient-with-evidence extraction envelope.');

export const ExtractionResultEnvelopeUnknown = extractionResultEnvelope(z.unknown());

export type ExtractionResultEnvelopeUnknown = z.infer<typeof ExtractionResultEnvelopeUnknown>;

export const isExtractionErrorRow = (row: unknown): row is ExtractionErrorRow =>
  ExtractionErrorRow.safeParse(row).success;

export const filterValidExtractionRows = <TRow>(rows: (TRow | ExtractionErrorRow)[]): TRow[] =>
  rows.filter((row): row is TRow => !isExtractionErrorRow(row));
