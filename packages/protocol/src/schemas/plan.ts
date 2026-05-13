import { z } from 'zod';

import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { SCHEMA_VERSION } from '../version.js';

import { CaptureRef } from './refs.js';
import { SecurityScope } from './security.js';
import { Step } from './steps.js';
import type { TaskRequest } from './task.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const OutputBinding = z
  .object({
    name: z.string().min(1).describe('Output binding name.'),
    from: CaptureRef.describe('Capture reference used to populate output.'),
  })
  .describe('Named output mapping from a capture reference.');

export type OutputBinding = z.infer<typeof OutputBinding>;

export const PlanSchema = z
  .object({
    task_id: z.string().regex(ULID_PATTERN).describe('Owning task id.'),
    plan_id: z.string().regex(ULID_PATTERN).describe('Unique plan id.'),
    schema_version: z.literal(SCHEMA_VERSION).describe('Protocol schema version literal.'),
    default_scope: SecurityScope.describe('Default scope applied when step scope is null.'),
    steps: z.array(Step).min(1).max(64).describe('Ordered finite list of plan steps.'),
    outputs: z.array(OutputBinding).default([]).describe('Optional plan outputs.'),
  })
  .describe('Validated execution plan produced by the agent.');

export type Plan = z.infer<typeof PlanSchema>;

export class TaskMismatchError extends Error {
  public constructor(
    public readonly taskIdFromRequest: string,
    public readonly taskIdFromPlan: string,
  ) {
    super(`Task id mismatch: request=${taskIdFromRequest}, plan=${taskIdFromPlan}`);
    this.name = 'TaskMismatchError';
  }
}

export const assertSameTask = (
  request: Pick<TaskRequest, 'task_id'>,
  plan: Pick<Plan, 'task_id'>,
): Result<true, TaskMismatchError> => {
  if (request.task_id === plan.task_id) {
    return ok(true);
  }

  return err(new TaskMismatchError(request.task_id, plan.task_id));
};
