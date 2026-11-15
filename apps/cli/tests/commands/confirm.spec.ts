import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { createConfirmationStore, resetPathCache, runsRoot } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../src/execute.js';

function streamBuffer(): { stream: Writable; text: () => string } {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  return { stream, text: () => output };
}

async function runConfirm(home: string, argv: readonly string[]) {
  const stdout = streamBuffer();
  const stderr = streamBuffer();
  const result = await executeCommand(
    argv,
    createTerminalContext({
      env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
      cwd: home,
      isTty: false,
      stdout: stdout.stream,
      stderr: stderr.stream,
    }),
  );
  return { result, stdout: stdout.text(), stderr: stderr.text() };
}

const request = {
  confirmation_id: '01J00000000000000000000011',
  run_id: 'run-json',
  step_id: 'checkout',
  action_kind: 'click' as const,
  host: 'shop.example',
  description: 'Confirm checkout',
  expected_cost: null,
  consequence: 'unknown' as const,
  requested_at: '2026-11-03T12:00:00.000Z',
  timeout_ms: null,
};

describe('@no-llm confirm parked output', () => {
  it('keeps the legacy JSON keys and adds the parked response envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-confirm-json-'));
    vi.stubEnv('YANTRA_HOME', home);
    resetPathCache();
    try {
      const store = createConfirmationStore(join(runsRoot(), request.run_id));
      await store.appendRequest(request);
      const result = await runConfirm(home, ['confirm', request.run_id, 'grant', '--json']);
      expect(result.result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({ runId: request.run_id, case: 'parked' });
      expect(parsed).toHaveProperty('decision');
      expect(parsed).toHaveProperty('request');
      expect(parsed).toMatchObject({ response: { status: 'accepted' } });
    } finally {
      vi.unstubAllEnvs();
      resetPathCache();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports a duplicate parked answer as already decided', async () => {
    const home = await mkdtemp(join(tmpdir(), 'yantra-confirm-duplicate-'));
    vi.stubEnv('YANTRA_HOME', home);
    resetPathCache();
    try {
      const store = createConfirmationStore(join(runsRoot(), request.run_id));
      await store.appendRequest({ ...request, confirmation_id: '01J00000000000000000000012' });
      await runConfirm(home, ['confirm', request.run_id, 'grant', '--json']);
      const result = await runConfirm(home, ['confirm', request.run_id, 'deny', '--json']);
      expect(result.result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        case: 'parked',
        response: { status: 'already_decided', decision: 'granted' },
      });
    } finally {
      vi.unstubAllEnvs();
      resetPathCache();
      await rm(home, { recursive: true, force: true });
    }
  });
});
