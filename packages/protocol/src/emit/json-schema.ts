import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { CommandInvocation } from '../commands/invocation.js';
import { CommandRegistry } from '../commands/schema.js';
import { AgentProgressEvent } from '../schemas/agent-progress.js';
import { Brief } from '../schemas/brief.js';
import { CommandResultMessageSchema } from '../schemas/command-result.js';
import { ConfirmationDecision, ConfirmationRequest } from '../schemas/confirmation.js';
import { DiscoverySession } from '../schemas/discovery.js';
import { TaskEvent } from '../schemas/events.js';
import { ExecutionReceiptSchema } from '../schemas/execution-receipt.js';
import { ExtractionResultEnvelopeUnknown } from '../schemas/extraction.js';
import { PlanSchema } from '../schemas/plan.js';
import { LocatorChain, ValueRef } from '../schemas/refs.js';
import { RunChannelMessage, WorkerLaunch } from '../schemas/run-channel.js';
import { RunEvent, RunEventRecord } from '../schemas/run-event.js';
import { RunHealth } from '../schemas/run-health.js';
import { RunLease } from '../schemas/run-lease.js';
import { Step } from '../schemas/steps.js';
import { TaskContractRecord } from '../schemas/task-contract.js';
import { TaskRequest } from '../schemas/task.js';
import { UsageLedger } from '../schemas/usage.js';
import { WorkflowFile } from '../schemas/workflow.js';

/**
 * MVP schema URL strategy uses package-local relative paths first.
 * Hosted URLs can be introduced later without changing the source schema definitions.
 */
export const JSON_SCHEMA_ARTIFACTS: Record<string, { schema: z.ZodType<unknown>; name: string }> = {
  'execution-receipt.json': { schema: ExecutionReceiptSchema, name: 'ExecutionReceipt' },
  'command-result.json': { schema: CommandResultMessageSchema, name: 'CommandResultMessage' },
  'task-request.json': { schema: TaskRequest, name: 'TaskRequest' },
  'plan.json': { schema: PlanSchema, name: 'Plan' },
  'step.json': { schema: Step, name: 'Step' },
  'task-event.json': { schema: TaskEvent, name: 'TaskEvent' },
  'run-event.json': { schema: RunEvent, name: 'RunEvent' },
  'run-event-record.json': { schema: RunEventRecord, name: 'RunEventRecord' },
  'agent-progress-event.json': { schema: AgentProgressEvent, name: 'AgentProgressEvent' },
  'value-ref.json': { schema: ValueRef, name: 'ValueRef' },
  'locator-chain.json': { schema: LocatorChain, name: 'LocatorChain' },
  'workflow.json': { schema: WorkflowFile, name: 'WorkflowFile' },
  'extraction-result-envelope.json': {
    schema: ExtractionResultEnvelopeUnknown,
    name: 'ExtractionResultEnvelope',
  },
  'usage-ledger.json': { schema: UsageLedger, name: 'UsageLedger' },
  'brief.schema.json': { schema: Brief, name: 'Brief' },
  'confirmation-request.json': { schema: ConfirmationRequest, name: 'ConfirmationRequest' },
  'confirmation-decision.json': { schema: ConfirmationDecision, name: 'ConfirmationDecision' },
  'discovery-session.json': { schema: DiscoverySession, name: 'DiscoverySession' },
  'run-health.json': { schema: RunHealth, name: 'RunHealth' },
  'task-contract.json': { schema: TaskContractRecord, name: 'TaskContractRecord' },
  'command-registry.json': { schema: CommandRegistry, name: 'CommandRegistry' },
  'command-invocation.json': { schema: CommandInvocation, name: 'CommandInvocation' },
  'run-lease.json': { schema: RunLease, name: 'RunLease' },
  'run-channel-message.json': { schema: RunChannelMessage, name: 'RunChannelMessage' },
  'worker-launch.json': { schema: WorkerLaunch, name: 'WorkerLaunch' },
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
