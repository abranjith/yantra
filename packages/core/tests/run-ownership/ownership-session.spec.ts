// @no-llm
/**
 * Browser ownership through the launcher, and the ownership session's
 * open/finish order (FEAT-064 TASK-004; RC2 dropped the lease heartbeat).
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserProcessError } from '../../src/browser/errors.js';
import type {
  ProcessIdentity,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import { parseLaunchOptions } from '../../src/browser/launch-options.js';
import { launchResolvedChrome } from '../../src/browser/launcher.js';
import type { ResolvedProfile } from '../../src/browser/types.js';
import { RUN_EVENTS_FILENAME, RunEventLog } from '../../src/run-events/log.js';
import type { BrowserOwnershipRecorder } from '../../src/run-ownership/browser-ownership-recorder.js';
import { RUN_LEASE_FILENAME } from '../../src/run-ownership/constants.js';
import { RunLeaseHeldError } from '../../src/run-ownership/errors.js';
import { claimLease, readLease, readOwnedBrowsers } from '../../src/run-ownership/lease-store.js';
import {
  RunOwnershipSession,
  type RunChannelEndpoint,
  type StartRunChannel,
} from '../../src/run-ownership/ownership-session.js';
import { assistantText, taskStarted } from '../run-events/support.js';

import { OWNER, SOCKET, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

class FakeChild extends EventEmitter {
  pid: number | undefined = 5150;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  exit(code: number | null = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function fakeBrowser(closeBehavior: 'exit' | 'hang' = 'exit'): Browser {
  const child = new FakeChild();
  return {
    process: () => child as unknown as ChildProcess,
    close: () => {
      if (closeBehavior === 'exit') child.exit(0);
      return Promise.resolve();
    },
  } as unknown as Browser;
}

const systemInstallation: ResolvedBrowserInstallation = {
  canonicalPath: '/usr/bin/google-chrome',
  version: '153.0.8010.36',
  majorVersion: 153,
  platform: 'linux',
  architecture: 'x64',
  statFingerprint: '1:2:3:4',
  ownership: 'external',
  requestedSelection: { source: 'auto', executablePath: null },
  selectionOrigin: 'default',
  selectionReason: 'system-discovery',
  channel: 'stable',
  managedIdentity: null,
};
const profile: ResolvedProfile = {
  absolutePath: '/tmp/yantra-own-test',
  kind: 'ephemeral',
  createdNow: true,
};

function loggingRecorder(log: string[], fail: 'spawned' | null = null): BrowserOwnershipRecorder {
  return {
    recordSpawned: (identity: ProcessIdentity) => {
      log.push(`spawned:${identity.pid}:${identity.startToken}`);
      return fail === 'spawned' ? Promise.reject(new Error('disk full')) : Promise.resolve();
    },
    recordExited: (identity: ProcessIdentity) => {
      log.push(`exited:${identity.pid}`);
      return Promise.resolve();
    },
  };
}

describe('@no-llm browser ownership through launchResolvedChrome', () => {
  it('records a system (non-managed) browser before the launch resolves', async () => {
    const log: string[] = [];
    const launching = launchResolvedChrome(
      parseLaunchOptions({ profile: { kind: 'ephemeral' } }),
      systemInstallation,
      profile,
      { kind: 'external' },
      {
        launch: () => Promise.resolve(fakeBrowser()),
        identify: (pid) => Promise.resolve({ pid, startToken: 'linux:77' }),
        recorder: loggingRecorder(log),
      },
    );
    const launched = await launching;
    expect(log).toEqual(['spawned:5150:linux:77']);
    await launched.shutdown();
    expect(log).toEqual(['spawned:5150:linux:77', 'exited:5150']);
  });

  it('records an unknown start token when the identity cannot be read', async () => {
    const log: string[] = [];
    const launched = await launchResolvedChrome(
      parseLaunchOptions({ profile: { kind: 'ephemeral' } }),
      systemInstallation,
      profile,
      { kind: 'external' },
      {
        launch: () => Promise.resolve(fakeBrowser()),
        identify: () => Promise.resolve(null),
        recorder: loggingRecorder(log),
      },
    );
    expect(log).toEqual(['spawned:5150:unknown']);
    await launched.shutdown();
  });

  it('keeps the entry when the exit cannot be proved', async () => {
    const log: string[] = [];
    const launched = await launchResolvedChrome(
      parseLaunchOptions({ profile: { kind: 'ephemeral' } }),
      systemInstallation,
      profile,
      { kind: 'external' },
      {
        launch: () => Promise.resolve(fakeBrowser('hang')),
        identify: (pid) => Promise.resolve({ pid, startToken: 'linux:77' }),
        recorder: loggingRecorder(log),
        terminator: { terminate: () => Promise.resolve() },
        gracefulCloseMs: 10,
        terminationMs: 20,
      },
    );
    await expect(launched.shutdown()).rejects.toBeInstanceOf(BrowserProcessError);
    expect(log).toEqual(['spawned:5150:linux:77']);
  });

  it('shuts the browser down when it cannot be recorded, so none is left unrecorded', async () => {
    const log: string[] = [];
    const browser = fakeBrowser();
    await expect(
      launchResolvedChrome(
        parseLaunchOptions({ profile: { kind: 'ephemeral' } }),
        systemInstallation,
        profile,
        { kind: 'external' },
        {
          launch: () => Promise.resolve(browser),
          identify: (pid) => Promise.resolve({ pid, startToken: 'linux:77' }),
          recorder: loggingRecorder(log, 'spawned'),
        },
      ),
    ).rejects.toThrow('disk full');
    expect((browser.process() as unknown as FakeChild).exitCode).toBe(0);
  });

  it('never identifies an external browser when no recorder is given', async () => {
    let identified = 0;
    const launched = await launchResolvedChrome(
      parseLaunchOptions({ profile: { kind: 'ephemeral' } }),
      systemInstallation,
      profile,
      { kind: 'external' },
      {
        launch: () => Promise.resolve(fakeBrowser()),
        identify: (pid) => {
          identified += 1;
          return Promise.resolve({ pid, startToken: 'x' });
        },
      },
    );
    await launched.shutdown();
    expect(identified).toBe(0);
  });
});

function fakeChannel(log: string[], runDir: string): StartRunChannel {
  return ({ token }) => {
    log.push(`listen:${token.length}`);
    const endpoint: RunChannelEndpoint = {
      address: SOCKET,
      close: (drainMs) => {
        log.push(`close:${drainMs}:lease=${existsSync(join(runDir, RUN_LEASE_FILENAME))}`);
        return Promise.resolve();
      },
    };
    return Promise.resolve(endpoint);
  };
}

describe('@no-llm RunOwnershipSession', () => {
  it('listens first, then claims a lease naming that socket and the server token', async () => {
    const runDir = makeTempDir();
    const log: string[] = [];
    let serverToken = '';
    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r1',
      origin: 'daemon',
      executionClass: 'run',
      command: ['run', 'statement'],
      identity: OWNER,
      startChannel: (options) => {
        serverToken = options.token;
        return fakeChannel(log, runDir)(options);
      },
    });
    const read = await readLease(runDir);
    expect(read.kind).toBe('lease');
    expect(session.lease.socket).toEqual(SOCKET);
    expect(session.lease.run_token).toBe(serverToken);
    expect(session.lease).toMatchObject({ origin: 'daemon', run_id: 'r1' });
    expect(log).toEqual(['listen:43']);
    await session.finish();
  });

  it('takes log_seq_at_claim from the run-events tail', async () => {
    const runDir = makeTempDir();
    const log = RunEventLog.open({ runDir, runId: 'r1', sync: () => undefined });
    log.append(taskStarted());
    log.append(assistantText('a'));
    log.append(assistantText('b'));
    log.close();
    appendFileSync(join(runDir, RUN_EVENTS_FILENAME), '{"partial');
    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r1',
      origin: 'terminal',
      executionClass: 'run',
      command: ['resume'],
      identity: OWNER,
      startChannel: fakeChannel([], runDir),
    });
    expect(session.lease.log_seq_at_claim).toBe(3);
    await session.finish();
  });

  it('finishes in order: drain and close the socket, then release the lease; idempotent', async () => {
    const runDir = makeTempDir();
    const log: string[] = [];
    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r1',
      origin: 'terminal',
      executionClass: 'run',
      command: ['research'],
      identity: OWNER,
      startChannel: fakeChannel(log, runDir),
    });
    await Promise.all([session.finish(), session.finish()]);
    await session.finish();
    expect(log).toEqual(['listen:43', 'close:1000:lease=true']);
    expect(await readLease(runDir)).toEqual({ kind: 'absent' });
  });

  it('closes its socket again when the claim loses', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    const log: string[] = [];
    await expect(
      RunOwnershipSession.open({
        runDir,
        runId: 'r1',
        origin: 'terminal',
        executionClass: 'run',
        command: ['research'],
        identity: { pid: 1, startToken: 'other' },
        startChannel: fakeChannel(log, runDir),
      }),
    ).rejects.toBeInstanceOf(RunLeaseHeldError);
    expect(log).toEqual(['listen:43', 'close:0:lease=true']);
  });

  it('records browsers through its recorder, and keeps the lease if one exit is unproved', async () => {
    const runDir = makeTempDir();
    const warnings: string[] = [];
    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r1',
      origin: 'terminal',
      executionClass: 'run',
      command: ['research'],
      identity: OWNER,
      startChannel: fakeChannel([], runDir),
      logger: {
        info: () => undefined,
        debug: () => undefined,
        error: () => undefined,
        warn: (_fields: unknown, message?: string) => {
          warnings.push(message ?? '');
        },
      },
    });
    await session.recorder.recordSpawned({ pid: 9, startToken: 'linux:9' });
    expect(await readOwnedBrowsers(runDir)).toEqual([{ pid: 9, startToken: 'linux:9' }]);
    await session.finish();
    expect((await readLease(runDir)).kind).toBe('lease');
    expect(warnings).toEqual(['run_lease_retained']);
  });
});
