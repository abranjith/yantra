// @no-llm
/**
 * What a finished run may have changed, for the Run again warning
 * (FEAT-067 TASK-013).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assessPriorEffects } from '../../src/run-recovery/prior-effects.js';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'yantra-effects-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function write(name: string, value: unknown): Promise<void> {
  await writeFile(join(runDir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function contract(submit: 'allowed' | 'forbidden') {
  return {
    schema_version: '1',
    run_id: 'run-1',
    command: 'do',
    revisions: [
      {
        revision: 1,
        declared_at: '2026-11-14T10:00:00.000Z',
        contract: {
          deliverable: 'actions',
          effects: { submit },
          constraints: [],
          fill: null,
          artifacts: [],
        },
      },
    ],
  };
}

async function events(kinds: { kind: string; step_id?: string }[]): Promise<void> {
  const lines = kinds.map((event, index) =>
    JSON.stringify({
      schema_version: '1',
      seq: index + 1,
      run_id: 'run-1',
      event: { task_id: 't', at: '2026-11-14T10:00:00.000Z', capture_keys: [], ...event },
    }),
  );
  await write('run-events.jsonl', `${lines.join('\n')}\n`);
}

describe('@no-llm assessPriorEffects', () => {
  it('is verified when the Brief cites fills and clicks, naming them and the hosts', async () => {
    await write('brief.json', {
      actions: [
        { kind: 'fill', host: 'shop.test' },
        { kind: 'fill', host: 'shop.test' },
        { kind: 'fill', host: 'shop.test' },
        { kind: 'click', host: 'pay.test' },
        { kind: 'capture', host: 'shop.test' },
      ],
    });

    expect(await assessPriorEffects(runDir, 'external')).toEqual({
      effects: 'verified',
      reasons: ['The previous run filled 3 fields and clicked 1 control on shop.test, pay.test.'],
    });
  });

  it('adds that submitting was allowed when the contract said so', async () => {
    await write('brief.json', { actions: [{ kind: 'fill', host: 'example.org' }] });
    await write('contract.json', contract('allowed'));

    expect((await assessPriorEffects(runDir, 'external')).reasons).toEqual([
      'The previous run filled 1 field on example.org.',
      'It was allowed to submit a form.',
    ]);
  });

  it('is possible when submitting was allowed and no action was recorded', async () => {
    await write('brief.json', { actions: [] });
    await write('contract.json', contract('allowed'));

    expect(await assessPriorEffects(runDir, 'external')).toEqual({
      effects: 'possible',
      reasons: ['The previous run was allowed to submit a form, and no action was recorded.'],
    });
  });

  it('is none for a research run with a Brief and no actions', async () => {
    await write('brief.json', { title: 'quiet laptops', sources: [] });
    await write('contract.json', contract('forbidden'));

    expect(await assessPriorEffects(runDir, 'external')).toEqual({ effects: 'none', reasons: [] });
  });

  it('is possible for a legacy do run that recorded no evidence', async () => {
    expect(await assessPriorEffects(runDir, 'external')).toEqual({
      effects: 'possible',
      reasons: [
        'The previous run recorded no evidence of what it did on websites, so it may have changed something.',
      ],
    });
    expect(await assessPriorEffects(runDir, 'local')).toEqual({ effects: 'none', reasons: [] });
  });

  it('is verified when a submitting workflow step completed, and not when it never ran', async () => {
    await write('plan.json', {
      steps: [
        { id: 's1', verb: 'navigate' },
        { id: 's2', verb: 'fill', submit: true },
      ],
    });
    await events([{ kind: 'step_completed', step_id: 's1' }]);
    expect(await assessPriorEffects(runDir, 'external')).toEqual({ effects: 'none', reasons: [] });

    await events([
      { kind: 'step_completed', step_id: 's1' },
      { kind: 'step_completed', step_id: 's2' },
    ]);

    expect(await assessPriorEffects(runDir, 'external')).toEqual({
      effects: 'verified',
      reasons: ['The workflow submitted a form (step s2).'],
    });
  });

  it('treats corrupt artifacts as no evidence from them, without throwing', async () => {
    await write('brief.json', '{ broken');
    await write('contract.json', '[]');
    await write('plan.json', 'null');

    expect(await assessPriorEffects(runDir, 'external')).toEqual({
      effects: 'possible',
      reasons: [
        'The previous run recorded no evidence of what it did on websites, so it may have changed something.',
      ],
    });
  });
});
