// @no-llm
/**
 * REV-011: `RunOwnershipSession.open` announces each lease it claims, in
 * process, so an app-launched worker can record its run without scanning
 * run directories.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { RunLease } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  announceRunLeaseClaimed,
  onRunLeaseClaimed,
} from '../../src/run-ownership/claim-events.js';
import { RunOwnershipSession } from '../../src/run-ownership/ownership-session.js';
import { cleanupSandbox, makeRunDir, sandboxHome } from '../run-channel/support.js';

const sessions: RunOwnershipSession[] = [];
const disposers: (() => void)[] = [];

beforeEach(() => {
  sandboxHome();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await Promise.all(sessions.splice(0).map((session) => session.finish()));
  cleanupSandbox();
});

describe('@no-llm run lease claim notice', () => {
  it('announces the lease a session claims, once', async () => {
    const runDir = join(makeRunDir(), 'r-claim');
    mkdirSync(runDir, { recursive: true });
    const seen: RunLease[] = [];
    disposers.push(onRunLeaseClaimed((lease) => seen.push(lease)));

    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r-claim',
      origin: 'worker',
      executionClass: 'run',
      command: ['run', 'fixture'],
    });
    sessions.push(session);

    expect(seen).toEqual([session.lease]);
    expect(seen[0]?.owner.pid).toBe(process.pid);
  });

  it('stops calling a listener once it unsubscribes', () => {
    const seen: string[] = [];
    const dispose = onRunLeaseClaimed((lease) => seen.push(lease.run_id));
    announceRunLeaseClaimed({ run_id: 'a' } as RunLease);
    dispose();
    announceRunLeaseClaimed({ run_id: 'b' } as RunLease);
    expect(seen).toEqual(['a']);
  });

  it('keeps notifying the other listeners when one throws', () => {
    const seen: string[] = [];
    disposers.push(
      onRunLeaseClaimed(() => {
        throw new Error('listener failed');
      }),
    );
    disposers.push(onRunLeaseClaimed((lease) => seen.push(lease.run_id)));
    expect(() => announceRunLeaseClaimed({ run_id: 'c' } as RunLease)).not.toThrow();
    expect(seen).toEqual(['c']);
  });
});
