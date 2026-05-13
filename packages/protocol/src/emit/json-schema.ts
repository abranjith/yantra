import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { TaskEvent } from '../schemas/events.js';
import { ExtractionResultEnvelopeUnknown } from '../schemas/extraction.js';
import { PlanSchema } from '../schemas/plan.js';
import { LocatorChain, ValueRef } from '../schemas/refs.js';
import { Step } from '../schemas/steps.js';
import { TaskRequest } from '../schemas/task.js';
import { UsageLedger } from '../schemas/usage.js';
import { WorkflowFile } from '../schemas/workflow.js';

/**
 * MVP schema URL strategy uses package-local relative paths first.
 * Hosted URLs can be introduced later without changing the source schema definitions.
 */
export const JSON_SCHEMA_ARTIFACTS: Record<string, { schema: z.ZodType<unknown>; name: string }> = {
  'task-request.json': { schema: TaskRequest, name: 'TaskRequest' },
  'plan.json': { schema: PlanSchema, name: 'Plan' },
  'step.json': { schema: Step, name: 'Step' },
  'task-event.json': { schema: TaskEvent, name: 'TaskEvent' },
  'value-ref.json': { schema: ValueRef, name: 'ValueRef' },
  'locator-chain.json': { schema: LocatorChain, name: 'LocatorChain' },
  'workflow.json': { schema: WorkflowFile, name: 'WorkflowFile' },
  'extraction-result-envelope.json': {
    schema: ExtractionResultEnvelopeUnknown,
    name: 'ExtractionResultEnvelope',
  },
  'usage-ledger.json': { schema: UsageLedger, name: 'UsageLedger' },
} as const;

export type JsonSchemaArtifactName = keyof typeof JSON_SCHEMA_ARTIFACTS;

export const emitJsonSchemas = async (outputDirectory: string): Promise<void> => {
  await mkdir(outputDirectory, { recursive: true });

  await Promise.all(
    Object.entries(JSON_SCHEMA_ARTIFACTS).map(async ([fileName, entry]) => {
      const schema = zodToJsonSchema(entry.schema, {
        name: entry.name,
        target: 'jsonSchema7',
        $refStrategy: 'root',
      });

      const outputPath = path.join(outputDirectory, fileName);
      await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    }),
  );
};
