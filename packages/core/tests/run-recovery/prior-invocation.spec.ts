// @no-llm
/**
 * Rebuilding a finished run's command for Run again (FEAT-067 TASK-013).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseInvocation, type ExecutionReceipt, type ReceiptSetting } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recoverPriorInvocation } from '../../src/run-recovery/prior-invocation.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'yantra-prior-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function receipt(command: [string, ...string[]], settings: ReceiptSetting[]): ExecutionReceipt {
  return {
    schema_version: 1,
    run_id: 'run-1',
    sequence: 0,
    written_at: '2026-11-14T10:00:00.000Z',
    yantra_version: '0.2 (yantra cli)',
    invoked_by: 'worker',
    invocation_id: null,
    command,
    cwd: CWD,
    settings,
    content: [],
    browser: null,
  };
}

async function write(name: string, value: unknown): Promise<void> {
  await writeFile(join(runDir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

async function goalEcho(display: string, truncated = false): Promise<void> {
  const record = {
    schema_version: '1',
    seq: 1,
    run_id: 'run-1',
    event: {
      kind: 'goal_echo',
      display,
      received_chars: display.length,
      truncated,
      at: '2026-11-14T10:00:00.000Z',
    },
  };
  await write('run-events.jsonl', `${JSON.stringify(record)}\n`);
}

const AGENTIC_DO = {
  runId: 'run-1',
  taskId: 't',
  workflowName: 'do',
  workflowVersion: null,
  params: {},
  startedAt: '2026-11-14T10:00:00.000Z',
  status: 'completed',
  profileKind: 'ephemeral',
  cookieProfilePath: null,
  outputBindingNames: [],
  runKind: 'agentic',
};

describe('@no-llm recoverPriorInvocation', () => {
  it('rebuilds from the receipt: the flags the user set, and every non-default setting pinned', async () => {
    await write('manifest.json', AGENTIC_DO);
    await goalEcho('goal: "fill the contact form"');
    await write(
      'execution-receipt.json',
      receipt(
        ['do'],
        [
          { key: 'allowHost', value: ['shop.test'], source: { kind: 'flag' } },
          { key: 'model', value: 'claude-x', source: { kind: 'env', name: 'YANTRA_AGENT_MODEL' } },
          {
            key: 'turnTimeout',
            value: '3m',
            source: { kind: 'preference', key: 'agent.turn_timeout' },
          },
          { key: 'thinking', value: null, source: { kind: 'default' } },
          { key: 'json', value: true, source: { kind: 'flag' } },
          { key: 'screenshots', value: false, source: { kind: 'flag' } },
        ],
      ),
    );

    const prior = await recoverPriorInvocation(runDir);

    expect(prior).toMatchObject({ prior: 'receipt', path: ['do'], cwd: CWD, notices: [] });
    expect(prior.argv).toEqual([
      'fill the contact form',
      '--allow-host',
      'shop.test',
      '--no-screenshots',
    ]);
    expect(prior.pinnedArgv).toEqual([
      'fill the contact form',
      '--allow-host',
      'shop.test',
      '--model',
      'claude-x',
      '--turn-timeout',
      '3m',
      '--no-screenshots',
    ]);
    expect(parseInvocation(['do', ...prior.pinnedArgv!], { cwd: CWD }).isOk).toBe(true);
  });

  it('reconstructs a workflow run from its manifest: name and params, no flags', async () => {
    await write('manifest.json', {
      ...AGENTIC_DO,
      workflowName: 'nightly',
      runKind: 'workflow',
      params: { city: 'Pune', limit: 5 },
    });

    expect(await recoverPriorInvocation(runDir)).toEqual({
      prior: 'reconstructed',
      path: ['run'],
      argv: ['nightly', '--params', 'city=Pune', '--params', 'limit=5'],
      pinnedArgv: ['nightly', '--params', 'city=Pune', '--params', 'limit=5'],
      cwd: null,
      notices: [],
    });
  });

  it('reconstructs a pipeline run from its query', async () => {
    await write('manifest.json', { type: 'research', query: 'quiet laptops', status: 'completed' });

    expect(await recoverPriorInvocation(runDir)).toMatchObject({
      prior: 'reconstructed',
      path: ['research'],
      argv: ['quiet laptops'],
    });
  });

  it('falls back to the echoed goal alone', async () => {
    await write('manifest.json', AGENTIC_DO);
    await goalEcho('goal: "book a table for "two""');

    expect(await recoverPriorInvocation(runDir)).toMatchObject({
      prior: 'goal_only',
      path: ['do'],
      argv: ['book a table for "two"'],
    });
  });

  it('does not reuse a goal that was cut short', async () => {
    await write('manifest.json', AGENTIC_DO);
    await goalEcho('goal: "a very long goal…"', true);

    expect(await recoverPriorInvocation(runDir)).toMatchObject({ prior: null, argv: null });
  });

  it('survives a corrupt receipt, saying so, and still rebuilds from the manifest', async () => {
    await write('manifest.json', { type: 'ask', query: 'what is new', status: 'completed' });
    await write('execution-receipt.json', '{ not json');

    const prior = await recoverPriorInvocation(runDir);

    expect(prior).toMatchObject({ prior: 'reconstructed', argv: ['what is new'] });
    expect(prior.notices).toEqual(['execution-receipt.json could not be read.']);
  });

  it('survives a receipt of the wrong shape and a corrupt manifest', async () => {
    await write('execution-receipt.json', { schema_version: 9 });
    await write('manifest.json', '{');

    const prior = await recoverPriorInvocation(runDir);

    expect(prior).toMatchObject({ prior: null, path: null });
    expect(prior.notices).toEqual([
      'execution-receipt.json is not a valid receipt.',
      'manifest.json could not be read.',
    ]);
  });

  it('returns nothing for an empty run directory, without throwing', async () => {
    expect(await recoverPriorInvocation(runDir)).toEqual({
      prior: null,
      path: null,
      argv: null,
      pinnedArgv: null,
      cwd: null,
      notices: [],
    });
  });

  it('keeps an operand that looks like a flag an operand', async () => {
    await write('manifest.json', { type: 'ask', query: '-5 degrees?', status: 'completed' });

    const prior = await recoverPriorInvocation(runDir);

    expect(prior.argv).toEqual(['--', '-5 degrees?']);
    expect(parseInvocation(['ask', ...prior.argv!], { cwd: CWD }).isOk).toBe(true);
  });
});
