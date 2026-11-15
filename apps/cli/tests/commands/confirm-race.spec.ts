// @no-llm
/**
 * Characterization suite for the §15 `yantra confirm` check-then-append race
 * (FEAT-068 TASK-001).
 *
 * Demonstrates that two concurrent `confirm` invocations for the same pending
 * request — synchronized between `hasDecision` and `appendDecision` — both pass
 * the check and append duplicate decision lines.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { ConfirmationStore, createConfirmationStore, resetPathCache, runsRoot } from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../src/execute.js';

let home: string;

function makeBufferStream(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buf += String(chunk);
      callback();
    },
  });
  return { stream, text: () => buf };
}

async function runConfirm(
  argv: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout = makeBufferStream();
  const stderr = makeBufferStream();
  const context = createTerminalContext({
    env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
    cwd: home,
    isTty: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const result = await executeCommand(argv, context);
  return { exitCode: result.exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-confirm-race-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(home, { recursive: true, force: true });
});

describe('@no-llm yantra confirm concurrency characterization (FEAT-068 TASK-001)', () => {
  it.fails(
    'allows only one concurrent confirm decision when two callers race between hasDecision and appendDecision',
    async () => {
      const runId = '20261103T120000Z-race-a1b2';
      const runDir = join(runsRoot(), runId);
      const store = createConfirmationStore(runDir);
      const req: ConfirmationRequest = {
        confirmation_id: '01J00000000000000000000010',
        run_id: runId,
        step_id: 'step_checkout',
        action_kind: 'click',
        host: 'shop.example',
        description: 'Confirm checkout',
        expected_cost: null,
        consequence: 'unknown',
        requested_at: '2026-11-03T12:00:00.000Z',
        timeout_ms: null,
      };
      await store.appendRequest(req);

      // Barrier: pause after `hasDecision` returns so both callers pass the check
      // before either proceeds to `appendDecision`.
      const origHasDecision = ConfirmationStore.prototype.hasDecision;
      let arrived = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      vi.spyOn(ConfirmationStore.prototype, 'hasDecision').mockImplementation(async function (
        this: ConfirmationStore,
        confirmationId: string,
      ) {
        const result = await origHasDecision.call(this, confirmationId);
        arrived += 1;
        if (arrived === 2) {
          releaseBarrier();
        }
        await barrier;
        return result;
      });

      const [first, second] = await Promise.all([
        runConfirm(['confirm', runId, 'grant']),
        runConfirm(['confirm', runId, 'deny']),
      ]);

      const entries = await store.readAll();
      const decisions = entries.filter((e) => e.kind === 'decision');

      // What SHOULD happen: exactly one winner (exit 0) and one loser (exit 1),
      // and exactly one decision line appended. Currently fails because both append.
      expect(decisions).toHaveLength(1);
      expect([first.exitCode, second.exitCode].sort((a, b) => a - b)).toEqual([0, 1]);
    },
  );
});
