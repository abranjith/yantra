// @no-llm
/**
 * `read.run_recovery` (FEAT-067 TASK-013): Resume and Run again for one
 * finished run, composed from the core assessments.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunRecoveryAssessment } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerMissionReads, runRecovery } from '../../../src/ui/host/mission-reads.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yantra-recovery-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(runId: string, files: Record<string, unknown>): void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function manifest(overrides: Record<string, unknown>) {
  return {
    runId: 'r',
    taskId: 't',
    workflowName: 'nightly',
    workflowVersion: 1,
    params: { city: 'Pune' },
    startedAt: '2026-11-14T10:00:00.000Z',
    endedAt: '2026-11-14T10:01:00.000Z',
    status: 'failed',
    durationMs: 60_000,
    profileKind: 'workflow',
    cookieProfilePath: null,
    outputBindingNames: [],
    ...overrides,
  };
}

describe('@no-llm read.run_recovery', () => {
  it('offers Resume for a failed workflow run, and Run again from its manifest', async () => {
    run('wf-failed', {
      'manifest.json': manifest({ runId: 'wf-failed', failureClass: 'locator_not_found' }),
      'plan.json': { steps: [{ id: 's1', verb: 'navigate' }] },
    });

    const result = await runRecovery('wf-failed', root);

    expect(RunRecoveryAssessment.safeParse(result).success).toBe(true);
    expect(result.resume).toEqual({
      available: true,
      requires_consent: false,
      failure_class: 'locator_not_found',
    });
    expect(result.run_again).toMatchObject({
      prior: 'reconstructed',
      path: ['run'],
      argv: ['nightly', '--params', 'city=Pune'],
      effects: 'none',
    });
  });

  it('asks for consent to resume past a scope violation', async () => {
    run('wf-scope', {
      'manifest.json': manifest({ runId: 'wf-scope', failureClass: 'scope_violation' }),
      'plan.json': { steps: [] },
    });

    expect((await runRecovery('wf-scope', root)).resume).toEqual({
      available: true,
      requires_consent: true,
      failure_class: 'scope_violation',
    });
  });

  it('refuses Resume for an agentic do run and warns that it filled fields', async () => {
    run('do-1', {
      'manifest.json': manifest({
        runId: 'do-1',
        workflowName: 'do',
        runKind: 'agentic',
        profileKind: 'ephemeral',
        params: {},
      }),
      'brief.json': {
        actions: [
          { kind: 'fill', host: 'shop.test' },
          { kind: 'fill', host: 'shop.test' },
        ],
      },
      'run-events.jsonl': `${JSON.stringify({
        schema_version: '1',
        seq: 1,
        run_id: 'do-1',
        event: {
          kind: 'goal_echo',
          display: 'goal: "fill the contact form"',
          received_chars: 21,
          truncated: false,
          at: '2026-11-14T10:00:00.000Z',
        },
      })}\n`,
    });

    const result = await runRecovery('do-1', root);

    expect(result.resume).toEqual({
      available: false,
      reason: 'Only saved workflow runs can be resumed. Use Run again.',
    });
    expect(result.run_again).toMatchObject({
      prior: 'goal_only',
      path: ['do'],
      argv: ['fill the contact form'],
      effects: 'verified',
      effect_reasons: ['The previous run filled 2 fields on shop.test.'],
    });
  });

  it('answers not_found for an unknown run', async () => {
    const refused = await runRecovery('missing', root).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).data.code).toBe('not_found');
  });

  it('serves the read over RPC and refuses a run ID that could escape the runs root', async () => {
    run('wf-ok', { 'manifest.json': manifest({ runId: 'wf-ok' }) });
    const methods = new RpcMethodRegistry();
    registerMissionReads(methods, { resolve: () => Promise.resolve([]), runsRoot: () => root });
    const method = methods.get('read.run_recovery')!;

    const result = await Promise.resolve(
      method.handler(method.params.parse({ run_id: 'wf-ok' }), {} as RpcCallContext),
    );

    expect(method.result.safeParse(result).success).toBe(true);
    expect(method.params.safeParse({ run_id: '../escape' }).success).toBe(false);
    expect(method.params.safeParse({ run_id: '..' }).success).toBe(false);
  });
});
