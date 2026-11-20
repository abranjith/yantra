import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DoctorResult,
  HostEnvironmentInfo,
  PossibleOrphansResult,
  RUN_LEASE_SCHEMA_VERSION,
  UNKNOWN_START_TOKEN_VALUE,
  type RunLease,
} from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerHealth } from '../../../src/ui/host/health.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcConnection,
} from '../../../src/ui/host/rpc-server.js';

const FAKE_CONNECTION: RpcConnection = {
  id: 1,
  windowId: 'win-1',
  notify: () => undefined,
  onClose: () => undefined,
};

function makeDoctorResult(overall: 'ok' | 'warn' | 'fail' = 'ok'): DoctorResult {
  return {
    checks: [
      {
        id: 'config.valid',
        title: 'Configuration schema valid',
        status: overall,
        summary: overall === 'fail' ? 'Config invalid' : 'Configuration is schema-valid.',
        ...(overall === 'fail' ? { remediation: 'Run `yantra config validate`.' } : {}),
      },
    ],
    overall,
    version: '0.0.1',
    platform: 'linux',
    nodeVersion: 'v24.15.0',
  };
}

describe('host read.doctor', () => {
  it('returns a DoctorResult-valid payload and passes refresh', async () => {
    const collect = vi.fn(async () => makeDoctorResult('ok'));
    const methods = new RpcMethodRegistry();
    registerHealth(methods, { env: {}, collect });

    const method = methods.get('read.doctor');
    expect(method).toBeDefined();

    const params = method!.params.parse({ refresh: true });
    const raw = await method!.handler(params, {
      windowId: 'win-1',
      connection: FAKE_CONNECTION,
    });
    const validated = method!.result.parse(raw);

    expect(collect).toHaveBeenCalledWith({ refresh: true });
    expect(DoctorResult.safeParse(validated).success).toBe(true);
  });

  it('returns DoctorResult even when overall is fail', async () => {
    const collect = vi.fn(async () => makeDoctorResult('fail'));
    const methods = new RpcMethodRegistry();
    registerHealth(methods, { env: {}, collect });

    const method = methods.get('read.doctor')!;
    const raw = await method.handler(method.params.parse({}), {
      windowId: 'win-1',
      connection: FAKE_CONNECTION,
    });
    expect((raw as DoctorResult).overall).toBe('fail');
  });

  it('throws RpcError when the collector returns an invalid DoctorResult', async () => {
    const collect = vi.fn(async () => ({ invalid: true }) as unknown as DoctorResult);
    const methods = new RpcMethodRegistry();
    registerHealth(methods, { env: {}, collect });

    const method = methods.get('read.doctor')!;
    await expect(
      method.handler(method.params.parse({}), {
        windowId: 'win-1',
        connection: FAKE_CONNECTION,
      }),
    ).rejects.toThrow(RpcError);
  });

  it('rejects unknown parameters', () => {
    const methods = new RpcMethodRegistry();
    registerHealth(methods, { env: {} });
    const method = methods.get('read.doctor')!;
    expect(method.params.safeParse({ unknownFlag: true }).success).toBe(false);
  });
});

describe('host read.host_status', () => {
  it('returns HostEnvironmentInfo without any environment variable names or canary values', async () => {
    const canaryKey = 'YANTRA_CANARY_HOST_ENV_KEY';
    const canaryValue = 'CANARY-HOST-ENV-SECRET-VALUE-998877';
    const methods = new RpcMethodRegistry();
    registerHealth(methods, {
      env: {
        [canaryKey]: canaryValue,
        ANTHROPIC_API_KEY: 'sk-ant-canary',
        PATH: '/usr/bin',
      },
      hostStatus: {
        host_started_at: '2026-11-19T10:00:00.000Z',
        env_captured_at: '2026-11-19T09:59:59.000Z',
        yantra_version: '0.1.0',
        host_pid: 4242,
      },
    });

    const method = methods.get('read.host_status')!;
    expect(method).toBeDefined();
    const raw = await method.handler(method.params.parse({}), {
      windowId: 'win-1',
      connection: FAKE_CONNECTION,
    });
    const validated = HostEnvironmentInfo.parse(raw);

    expect(validated).toEqual({
      host_started_at: '2026-11-19T10:00:00.000Z',
      env_captured_at: '2026-11-19T09:59:59.000Z',
      yantra_version: '0.1.0',
      host_pid: 4242,
    });

    const serialized = JSON.stringify(validated);
    expect(serialized).not.toContain(canaryKey);
    expect(serialized).not.toContain(canaryValue);
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
    expect(serialized).not.toContain('sk-ant-canary');
    expect(Object.keys(validated)).toEqual([
      'host_started_at',
      'env_captured_at',
      'yantra_version',
      'host_pid',
    ]);
  });
});

describe('host read.possible_orphans', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns retained unknown-identity records from runsDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yantra-host-orphans-'));
    tempDirs.push(root);
    const runDir = join(root, 'run-orphan-1');
    await mkdir(runDir, { recursive: true });
    const lease: RunLease = {
      schema_version: RUN_LEASE_SCHEMA_VERSION,
      run_id: 'run-orphan-1',
      owner: { pid: 5511, start_token: UNKNOWN_START_TOKEN_VALUE },
      origin: 'worker',
      execution_class: 'run',
      command: ['research'],
      socket: { kind: 'unix', address: '/tmp/yantra/0123456789abcdef01234567.sock' },
      run_token: 'A'.repeat(43),
      channel_version: 1,
      yantra_version: '0.1.0',
      log_seq_at_claim: 0,
      claimed_at: '2026-11-19T10:05:00.000Z',
    };
    await writeFile(join(runDir, 'lease.json'), JSON.stringify(lease));

    const methods = new RpcMethodRegistry();
    registerHealth(methods, {
      env: {},
      runsDir: root,
      probe: {
        identify: async () => null,
        check: async () => 'unknown',
      },
    });

    const method = methods.get('read.possible_orphans')!;
    const raw = await method.handler(method.params.parse({}), {
      windowId: 'win-1',
      connection: FAKE_CONNECTION,
    });
    const validated = PossibleOrphansResult.parse(raw);

    expect(validated.orphans).toEqual([
      {
        run_id: 'run-orphan-1',
        pid: 5511,
        recorded_start_token_present: false,
        executable: 'yantra',
        recorded_at: '2026-11-19T10:05:00.000Z',
        reason: 'identity_unverifiable',
      },
    ]);
  });
});
