import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunSocketAddress } from '@yantra/protocol';

import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../../src/browser/installation-types.js';
import type { LeaseClaimInit } from '../../src/run-ownership/lease-store.js';

const dirs: string[] = [];

/** A fresh temp run directory, removed by {@link cleanupDirs}. */
export function makeTempDir(prefix = 'yantra-own-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const SOCKET: RunSocketAddress = {
  kind: 'pipe',
  address: `\\\\.\\pipe\\yantra-${'ab'.repeat(16)}`,
};

export function claimInit(overrides: Partial<LeaseClaimInit> = {}): LeaseClaimInit {
  return {
    runId: '20261109T120000Z-research-0000abcd',
    origin: 'terminal',
    executionClass: 'run',
    command: ['research'],
    socket: SOCKET,
    logSeqAtClaim: 0,
    ...overrides,
  };
}

export const OWNER: ProcessIdentity = { pid: 4242, startToken: 'win32:1' };

/** A probe answering from a table keyed by `pid:startToken`, default `dead`. */
export class TableProbe implements ProcessLivenessProbe {
  public readonly checked: ProcessIdentity[] = [];
  public batches = 0;

  public constructor(
    private readonly table: Record<string, LivenessVerdict> = {},
    private readonly fallback: LivenessVerdict = 'dead',
  ) {}

  public set(identity: ProcessIdentity, verdict: LivenessVerdict): void {
    this.table[`${identity.pid}:${identity.startToken}`] = verdict;
  }

  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 'test' });
  }

  public check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    this.checked.push(identity);
    return Promise.resolve(this.table[`${identity.pid}:${identity.startToken}`] ?? this.fallback);
  }

  public async checkMany(identities: readonly ProcessIdentity[]): Promise<LivenessVerdict[]> {
    this.batches += 1;
    return Promise.all(identities.map((identity) => this.check(identity)));
  }
}
