import { describe, expect, it } from 'vitest';

import { TaskEvent } from '../src/index.js';

const at = '2026-05-12T00:00:00.000Z';
const task_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('@no-llm task events', () => {
  it('parses all event kinds', () => {
    const samples = [
      { kind: 'task_queued', task_id, at },
      { kind: 'task_started', task_id, at },
      { kind: 'step_started', task_id, at, step_id: 's1', step_type: 'navigate' },
      { kind: 'step_retry', task_id, at, step_id: 's1', attempt: 1, reason: 'network_error' },
      { kind: 'step_completed', task_id, at, step_id: 's1', capture_keys: [] },
      { kind: 'checkpoint_saved', task_id, at, after_step_id: 's1' },
      { kind: 'human_handoff_requested', task_id, at, step_id: 's2', reason: 'captcha' },
      { kind: 'task_completed', task_id, at, outputs_keys: ['summary'] },
      {
        kind: 'task_failed',
        task_id,
        at,
        failure_class: 'validation_error',
        report_path: 'report.md',
      },
      { kind: 'validation_failed', task_id, at, path: '/steps/1', message: 'bad step' },
      {
        kind: 'scope_violation',
        task_id,
        at,
        scope: 'read-only-data',
        attempted_verb: 'fill',
        step_id: 's2',
      },
    ];

    samples.forEach((sample) => {
      expect(TaskEvent.safeParse(sample).success).toBe(true);
    });
  });
});
