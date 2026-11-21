import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RUN_LEASE_SCHEMA_VERSION,
  UNKNOWN_START_TOKEN_VALUE,
  type OwnedBrowserEvent,
  type RunLease,
} from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../../src/browser/installation-types.js';
import { readPossibleOrphans } from '../../src/run/possible-orphans.js';
import { OWNED_BROWSERS_FILENAME, RUN_LEASE_FILENAME } from '../../src/run-ownership/constants.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yantra-possible-orphans-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLease(
  runId: string,
  pid: number,
  startToken: string,
  claimedAt = '2026-11-19T10:00:00.000Z',
): RunLease {
  return {
    schema_version: RUN_LEASE_SCHEMA_VERSION,
    run_id: runId,
    owner: { pid, start_token: startToken },
    origin: 'worker',
    execution_class: 'run',
    command: ['research'],
    socket: { kind: 'unix', address: '/tmp/yantra/0123456789abcdef01234567.sock' },
    run_token: 'A'.repeat(43),
    channel_version: 1,
    yantra_version: '0.1.0',
    log_seq_at_claim: 0,
    claimed_at: claimedAt,
  };
}

function makeFakeProbe(
  verdicts: ReadonlyMap<number, 'alive' | 'dead' | 'unknown'>,
): ProcessLivenessProbe & { signal?: ReturnType<typeof vi.fn> } {
  return {
    identify: vi.fn(async () => null),
    check: vi.fn(async (identity: ProcessIdentity) => verdicts.get(identity.pid) ?? 'unknown'),
  };
}

describe('@no-llm readPossibleOrphans', () => {
  it('lists unknown owners and unknown retained browsers, excluding alive and dead', async () => {
    const root = makeTempDir();

    const unknownOwnerDir = join(root, 'run-unknown-owner');
    await mkdir(unknownOwnerDir, { recursive: true });
    await writeFile(
      join(unknownOwnerDir, RUN_LEASE_FILENAME),
      JSON.stringify({
        ...makeLease(
          'run-unknown-owner',
          1001,
          UNKNOWN_START_TOKEN_VALUE,
          '2026-11-19T10:01:00.000Z',
        ),
        executable: '/usr/local/bin/yantra',
      }),
    );

    const aliveOwnerDir = join(root, 'run-alive-owner');
    await mkdir(aliveOwnerDir, { recursive: true });
    await writeFile(
      join(aliveOwnerDir, RUN_LEASE_FILENAME),
      JSON.stringify(makeLease('run-alive-owner', 1002, 'token-alive')),
    );

    const deadOwnerDir = join(root, 'run-dead-owner-with-unknown-browser');
    await mkdir(deadOwnerDir, { recursive: true });
    await writeFile(
      join(deadOwnerDir, RUN_LEASE_FILENAME),
      JSON.stringify(makeLease('run-dead-owner-with-unknown-browser', 1003, 'token-dead')),
    );

    const browserUnknown: OwnedBrowserEvent & { executable?: string } = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      op: 'spawned',
      pid: 2001,
      start_token: 'browser-token-1',
      at: '2026-11-19T10:02:00.000Z',
      executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    };
    const browserDead: OwnedBrowserEvent = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      op: 'spawned',
      pid: 2002,
      start_token: 'browser-token-2',
      at: '2026-11-19T10:03:00.000Z',
    };
    const browserExited: OwnedBrowserEvent = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      op: 'spawned',
      pid: 2003,
      start_token: 'browser-token-3',
      at: '2026-11-19T10:04:00.000Z',
    };
    const browserExitedDone: OwnedBrowserEvent = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      op: 'exited',
      pid: 2003,
      start_token: 'browser-token-3',
      at: '2026-11-19T10:05:00.000Z',
    };

    await writeFile(
      join(deadOwnerDir, OWNED_BROWSERS_FILENAME),
      `${[
        JSON.stringify(browserUnknown),
        JSON.stringify(browserDead),
        JSON.stringify(browserExited),
        JSON.stringify(browserExitedDone),
      ].join('\n')}\n`,
    );

    const probe = makeFakeProbe(
      new Map([
        [1001, 'unknown'],
        [1002, 'alive'],
        [1003, 'dead'],
        [2001, 'unknown'],
        [2002, 'dead'],
        [2003, 'unknown'],
      ]),
    );
    const terminator = { terminate: vi.fn() };

    const orphans = await readPossibleOrphans({ root, probe });

    expect(terminator.terminate).not.toHaveBeenCalled();
    expect(orphans.sort((a, b) => a.run_id.localeCompare(b.run_id))).toEqual([
      {
        run_id: 'run-dead-owner-with-unknown-browser',
        pid: 2001,
        recorded_start_token_present: true,
        executable: 'chrome.exe',
        recorded_at: '2026-11-19T10:02:00.000Z',
        reason: 'identity_unverifiable',
      },
      {
        run_id: 'run-unknown-owner',
        pid: 1001,
        recorded_start_token_present: false,
        executable: 'yantra',
        recorded_at: '2026-11-19T10:01:00.000Z',
        reason: 'identity_unverifiable',
      },
    ]);
  });

  it('fails per item on malformed records, never per list', async () => {
    const root = makeTempDir();

    const corruptDir = join(root, 'run-corrupt');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, RUN_LEASE_FILENAME), '{not-valid-json');

    const invalidSchemaDir = join(root, 'run-invalid-schema');
    await mkdir(invalidSchemaDir, { recursive: true });
    await writeFile(join(invalidSchemaDir, RUN_LEASE_FILENAME), JSON.stringify({ run_id: 'x' }));

    const validDir = join(root, 'run-valid');
    await mkdir(validDir, { recursive: true });
    await writeFile(
      join(validDir, RUN_LEASE_FILENAME),
      JSON.stringify(makeLease('run-valid', 3001, 'token-3001')),
    );

    const probe = makeFakeProbe(new Map([[3001, 'unknown']]));
    const orphans = await readPossibleOrphans({ root, probe });

    expect(orphans).toEqual([
      {
        run_id: 'run-valid',
        pid: 3001,
        recorded_start_token_present: true,
        executable: 'yantra',
        recorded_at: '2026-11-19T10:00:00.000Z',
        reason: 'identity_unverifiable',
      },
    ]);
  });

  it('returns an empty list when runs root does not exist', async () => {
    const root = join(makeTempDir(), 'does-not-exist');
    await expect(readPossibleOrphans({ root })).resolves.toEqual([]);
  });
});
