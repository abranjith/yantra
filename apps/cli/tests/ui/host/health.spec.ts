import { DoctorResult } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

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
