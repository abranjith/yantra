import { z } from 'zod';

import { SCHEMA_VERSION } from '../version.js';

import { SecretRef } from './refs.js';
import { SecurityClass } from './security.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ScalarValue = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe('Scalar value for task params.');

export type ScalarValue = z.infer<typeof ScalarValue>;

export const BudgetSchema = z
  .object({
    llm_calls: z.number().int().nonnegative().nullable().describe('Optional max LLM calls.'),
    fetches: z.number().int().nonnegative().nullable().describe('Optional max fetch actions.'),
  })
  .describe('Execution budget constraints.');

export type BudgetSchema = z.infer<typeof BudgetSchema>;

export const TaskRequest = z
  .object({
    task_id: z.string().regex(ULID_PATTERN).describe('Task identifier in ULID format.'),
    type: z.enum(['ask', 'run']).describe('Task type in MVP.'),
    intent: z.string().min(1).describe('User-provided intent statement.'),
    params: z
      .record(z.string(), ScalarValue)
      .default({})
      .describe('Runtime parameters for task execution.'),
    data_refs: z
      .array(SecretRef)
      .default([])
      .describe('Optional explicit secret references required by the task.'),
    deadline_ms: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('Optional overall deadline in milliseconds.'),
    budget: BudgetSchema.nullable().describe('Optional execution budget constraints.'),
    security_class: SecurityClass.describe('Security class for the task.'),
    schema_version: z.literal(SCHEMA_VERSION).describe('Protocol schema version literal.'),
  })
  .describe('Top-level task request entering the agent/executor pipeline.');

export type TaskRequest = z.infer<typeof TaskRequest>;
