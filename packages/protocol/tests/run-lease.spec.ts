// @no-llm
/**
 * Run lease, execution state and owned-browser records (FEAT-064 TASK-002).
 *
 * The lease is written once and never rewritten (spike S2, RC2), so these
 * schemas are the whole on-disk ownership contract: `lease.json`,
 * `owned-browsers.jsonl`, and the manifest's `executionState`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ExecutionState,
  OwnedBrowserEvent,
  ProcessIdentityRecord,
  RUN_TOKEN_PATTERN,
  RunLease,
  RunSocketAddress,
  TaskOutcome,
  TerminationReason,
  UNKNOWN_START_TOKEN_VALUE,
} from '../src/index.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, ...segments), 'utf8')) as unknown;
}

const TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg'; // 43 base64url characters

function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: '20261109T120000Z-research-0000abcd',
    owner: { pid: 4242, start_token: 'win32:134387061082204350' },
    origin: 'worker',
    execution_class: 'run',
    command: ['research'],
    socket: { kind: 'unix', address: `/home/u/.yantra/run/${'a'.repeat(24)}.sock` },
    run_token: TOKEN,
    channel_version: 1,
    yantra_version: '0.0.1',
    log_seq_at_claim: 12,
    claimed_at: '2026-11-09T12:00:00.000Z',
    ...overrides,
  };
}

/** The manifest fields the protocol owns for ownership; the rest is core's. */
const ManifestOwnershipFields = z.object({
  status: z.string(),
  taskOutcome: TaskOutcome.optional(),
  terminationReason: TerminationReason.optional(),
  executionState: ExecutionState.optional(),
});

describe('@no-llm RunLease', () => {
  it('round-trips a valid lease unchanged', () => {
    const value = lease();
    expect(RunLease.parse(value)).toEqual(value);
  });

  it('accepts an owner whose start token is unknown (verdict unknown, never dead)', () => {
    const parsed = RunLease.parse(readJson('run-ownership', 'lease-unknown-tokens.json'));
    expect(parsed.owner.start_token).toBe(UNKNOWN_START_TOKEN_VALUE);
  });

  it('accepts every origin and a log_seq_at_claim of zero', () => {
    for (const origin of ['terminal', 'worker', 'daemon']) {
      expect(RunLease.safeParse(lease({ origin, log_seq_at_claim: 0 })).success).toBe(true);
    }
  });

  it.each([
    ['a zero PID', { owner: { pid: 0, start_token: 'x' } }],
    ['a negative PID', { owner: { pid: -1, start_token: 'x' } }],
    ['a fractional PID', { owner: { pid: 1.5, start_token: 'x' } }],
    ['an empty start token', { owner: { pid: 1, start_token: '' } }],
    ['an extra key on the owner', { owner: { pid: 1, start_token: 'x', ppid: 2 } }],
    ['a short run token', { run_token: TOKEN.slice(1) }],
    ['a long run token', { run_token: `${TOKEN}A` }],
    ['a padded run token', { run_token: `${TOKEN.slice(0, 42)}=` }],
    ['a base64 (not base64url) run token', { run_token: `${TOKEN.slice(0, 42)}+` }],
    ['an unknown origin', { origin: 'app' }],
    ['an unknown execution class', { execution_class: 'sometimes' }],
    ['an empty command', { command: [] }],
    ['a negative log_seq_at_claim', { log_seq_at_claim: -1 }],
    ['a zero channel_version', { channel_version: 0 }],
    ['a non-ISO claimed_at', { claimed_at: 'yesterday' }],
    ['schema_version 2', { schema_version: 2 }],
  ])('rejects %s', (_label, change) => {
    expect(RunLease.safeParse(lease(change)).success).toBe(false);
  });

  it('strips, rather than rejects, a key from a newer owner (D17)', () => {
    const parsed = RunLease.parse(lease({ owned_browsers: [], heartbeat_at: 'x' }));
    expect(parsed).not.toHaveProperty('owned_browsers');
    expect(parsed).not.toHaveProperty('heartbeat_at');
  });

  it('matches only 43-character base64url tokens', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        expect(RUN_TOKEN_PATTERN.test(Buffer.from(bytes).toString('base64url'))).toBe(true);
      }),
    );
  });
});

describe('@no-llm RunSocketAddress', () => {
  it('accepts a unix socket of 24 hex characters and a yantra pipe of 32 hex characters', () => {
    expect(
      RunSocketAddress.safeParse({
        kind: 'unix',
        address: `/tmp/yantra-501/${'0f'.repeat(12)}.sock`,
      }).success,
    ).toBe(true);
    expect(
      RunSocketAddress.safeParse({
        kind: 'pipe',
        address: `\\\\.\\pipe\\yantra-${'ab'.repeat(16)}`,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a relative unix path', { kind: 'unix', address: `run/${'a'.repeat(24)}.sock` }],
    ['a unix name that is not 24 hex', { kind: 'unix', address: '/tmp/yantra-501/x.sock' }],
    [
      'a pipe without the yantra prefix',
      { kind: 'pipe', address: `\\\\.\\pipe\\${'a'.repeat(32)}` },
    ],
    ['a short pipe name', { kind: 'pipe', address: '\\\\.\\pipe\\yantra-abc' }],
    [
      'a unix kind with a pipe address',
      { kind: 'unix', address: `\\\\.\\pipe\\yantra-${'a'.repeat(32)}` },
    ],
    ['an unknown kind', { kind: 'tcp', address: '127.0.0.1:1' }],
  ])('rejects %s', (_label, value) => {
    expect(RunSocketAddress.safeParse(value).success).toBe(false);
  });
});

describe('@no-llm ExecutionState', () => {
  it('accepts exactly interrupted', () => {
    expect(ExecutionState.options).toEqual(['interrupted']);
    expect(ExecutionState.parse('interrupted')).toBe('interrupted');
  });

  it.each(['aborted', 'running', 'completed', '', 'INTERRUPTED'])('rejects %j', (value) => {
    expect(ExecutionState.safeParse(value).success).toBe(false);
  });
});

describe('@no-llm manifest ownership fields in both directions', () => {
  it('reads every pre-FEAT-064 manifest, which has no executionState', () => {
    const manifests = readJson('run-events', 'legacy', 'agent-manifests.json') as unknown[];
    for (const manifest of manifests) {
      expect(ManifestOwnershipFields.parse(manifest).executionState).toBeUndefined();
    }
  });

  it('reads an interrupted manifest whose outcome follows the evidence', () => {
    const parsed = ManifestOwnershipFields.parse(
      readJson('run-ownership', 'interrupted.manifest.json'),
    );
    expect(parsed).toMatchObject({
      executionState: 'interrupted',
      taskOutcome: 'partial',
      terminationReason: 'owner_lost',
    });
  });

  it('rejects an unknown executionState on a manifest', () => {
    const manifest = readJson('run-ownership', 'interrupted.manifest.json') as object;
    expect(ManifestOwnershipFields.safeParse({ ...manifest, executionState: 'lost' }).success).toBe(
      false,
    );
  });
});

describe('@no-llm OwnedBrowserEvent', () => {
  it('parses every line of an owned-browsers.jsonl, including an unknown start token', () => {
    const lines = readFileSync(join(FIXTURES, 'run-ownership', 'owned-browsers.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => OwnedBrowserEvent.parse(JSON.parse(line)));
    expect(lines.map((line) => line.op)).toEqual(['spawned', 'spawned', 'exited']);
    expect(lines[1]?.start_token).toBe(UNKNOWN_START_TOKEN_VALUE);
  });

  it.each([
    ['an unknown op', { op: 'killed' }],
    ['a zero PID', { pid: 0 }],
    ['an empty start token', { start_token: '' }],
    ['an extra key', { note: 'x' }],
  ])('rejects %s', (_label, change) => {
    const base = {
      schema_version: 1,
      op: 'spawned',
      pid: 7,
      start_token: 'linux:1',
      at: '2026-11-09T12:00:00.000Z',
    };
    expect(OwnedBrowserEvent.safeParse({ ...base, ...change }).success).toBe(false);
  });

  it('shares the identity shape with ProcessIdentityRecord', () => {
    const { pid, start_token } = OwnedBrowserEvent.parse({
      schema_version: 1,
      op: 'exited',
      pid: 9,
      start_token: 'darwin:Mon Nov  9 12:00:00 2026',
      at: '2026-11-09T12:00:00.000Z',
    });
    expect(ProcessIdentityRecord.parse({ pid, start_token })).toEqual({ pid, start_token });
  });
});
