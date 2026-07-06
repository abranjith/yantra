// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfirmationDecision, ConfirmationRequest, Plan, Step } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { ConfirmationGateway } from '../../src/executor/confirmation-gateway.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import type { EthicsGate } from '../../src/executor/types.js';

const noop = (): void => undefined;
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop };
const fakeEthics: EthicsGate = { check: () => Promise.resolve() };

function makePlan(): Plan {
  return {
    task_id: 'task-1',
    plan_id: 'plan-1',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps: [
      {
        id: 's1',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        type: 'navigate',
        url: { kind: 'literal', value: 'https://example.com' },
      } as Step,
    ],
    outputs: [],
  };
}

const grantingGateway: ConfirmationGateway = {
  request: (_req: ConfirmationRequest): Promise<ConfirmationDecision> =>
    Promise.resolve({
      confirmation_id: '',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:00.000Z',
      decided_by: 'user_interactive',
    }),
};

describe('createExecutionContext — confirmationGateway wiring (FEAT-019)', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yantra-ctx-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('places a provided confirmation gateway on the execution context', () => {
    const ctx = createExecutionContext({
      taskId: 'task-1',
      plan: makePlan(),
      runDir: tmpDir,
      ethics: fakeEthics,
      logger: fakeLogger,
      confirmationGateway: grantingGateway,
    });
    expect(ctx.confirmationGateway).toBe(grantingGateway);
  });

  it('defaults confirmationGateway to null when omitted (fail-closed)', () => {
    const ctx = createExecutionContext({
      taskId: 'task-1',
      plan: makePlan(),
      runDir: tmpDir,
      ethics: fakeEthics,
      logger: fakeLogger,
    });
    expect(ctx.confirmationGateway).toBeNull();
  });

  it('always provides a confirmation store so parked requests can be persisted', () => {
    const ctx = createExecutionContext({
      taskId: 'task-1',
      plan: makePlan(),
      runDir: tmpDir,
      ethics: fakeEthics,
      logger: fakeLogger,
    });
    expect(ctx.confirmationStore).not.toBeNull();
  });
});
