import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { runAgentSmoke } from '@yantra/agent';
import { loadSearchConfig, resetPathCache, runsRoot, type KeychainProvider } from '@yantra/core';
import { DOCTOR_CHECK_IDS, DoctorCheckId, DoctorResult } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_TITLES,
  collectDoctorResult,
  type DoctorRuntime,
} from '../../src/commands/doctor.js';

function fakeKeychain(): KeychainProvider {
  const store = new Map<string, string>();
  return {
    name: 'fake',
    isAvailable: () => Promise.resolve(true),
    get: async (service, account) => store.get(`${service}:${account}`) ?? null,
    set: async (service, account, value) => {
      store.set(`${service}:${account}`, value);
    },
    delete: async (service, account) => store.delete(`${service}:${account}`),
    list: async (service) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`${service}:`))
        .map((k) => k.slice(service.length + 1)),
  };
}

function makeRuntime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    env: {},
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTty: false,
    coreDoctor: vi.fn(async () => ({
      checks: [
        {
          id: 'browser.selection',
          status: 'ok' as const,
          message: 'Chrome selected',
          details: { source: 'auto', selectionOrigin: 'default' },
          fixHint: null,
        },
        {
          id: 'browser.compatibility',
          status: 'ok' as const,
          message: 'Compatible',
          details: { compatibility: 'passed', pairing: 'tested' },
          fixHint: null,
        },
        {
          id: 'browser.managed',
          status: 'ok' as const,
          message: 'Managed root ready',
          details: { managedRoot: '/tmp/browsers', orphanCount: 0, reclaimableBytes: 0 },
          fixHint: null,
        },
        {
          id: 'datadir.writable',
          status: 'ok' as const,
          message: 'Writable',
          details: {},
          fixHint: null,
        },
        {
          id: 'datadir.permissions',
          status: 'ok' as const,
          message: 'Safe',
          details: {},
          fixHint: null,
        },
        {
          id: 'cachedir.writable',
          status: 'ok' as const,
          message: 'Writable',
          details: {},
          fixHint: null,
        },
        {
          id: 'keychain.reachable',
          status: 'ok' as const,
          message: 'Reachable',
          details: {},
          fixHint: null,
        },
        {
          id: 'indexdb.writable',
          status: 'ok' as const,
          message: 'Writable',
          details: {},
          fixHint: null,
        },
      ],
      overall: 'ok' as const,
    })),
    agentDiagnostics: vi.fn(async () => [
      {
        id: 'agent.model',
        status: 'ok' as const,
        message: 'Model selected',
        details: {},
        fixHint: null,
      },
      {
        id: 'agent.credentials',
        status: 'ok' as const,
        message: 'Credentials available',
        details: {},
        fixHint: null,
      },
      {
        id: 'agent.budgets',
        status: 'ok' as const,
        message: 'Budgets valid',
        details: {},
        fixHint: null,
      },
    ]),
    loadPreferences: vi.fn(
      async () => ({}) as Awaited<ReturnType<DoctorRuntime['loadPreferences']>>,
    ),
    smoke: runAgentSmoke,
    runsRoot,
    keychain: async () => fakeKeychain(),
    searchConfig: loadSearchConfig,
    ...overrides,
  };
}

describe('doctor check IDs and collectDoctorResult', () => {
  let sandboxHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.YANTRA_HOME;
    sandboxHome = mkdtempSync(join(tmpdir(), 'yantra-doctor-ids-'));
    process.env.YANTRA_HOME = sandboxHome;
    resetPathCache();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.YANTRA_HOME;
    } else {
      process.env.YANTRA_HOME = prevHome;
    }
    resetPathCache();
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it('matches CHECK_TITLES keys to DoctorCheckId', () => {
    expect(Object.keys(CHECK_TITLES).sort()).toEqual([...DOCTOR_CHECK_IDS].sort());
  });

  it('emits only IDs in DoctorCheckId on a valid config', async () => {
    const result = await collectDoctorResult(makeRuntime(), { refresh: false });

    expect(DoctorResult.safeParse(result).success).toBe(true);
    for (const check of result.checks) {
      expect(DoctorCheckId.safeParse(check.id).success).toBe(true);
    }
    expect(result.checks.map((c) => c.id)).toContain('paths.resolved');
    expect(result.checks.map((c) => c.id)).toContain('search.provider');
  });

  it('emits only config.valid from configuration checks when config.yaml is invalid', async () => {
    writeFileSync(join(sandboxHome, 'config.yaml'), 'version: 999\ninvalid_key: true\n', 'utf8');

    const result = await collectDoctorResult(makeRuntime(), { refresh: true });

    expect(DoctorResult.safeParse(result).success).toBe(true);
    for (const check of result.checks) {
      expect(DoctorCheckId.safeParse(check.id).success).toBe(true);
    }
    const configCheckIds = result.checks
      .map((c) => c.id)
      .filter(
        (id) =>
          id === 'config.valid' ||
          id === 'paths.resolved' ||
          id === 'ethics.robots' ||
          id.startsWith('search.'),
      );
    expect(configCheckIds).toEqual(['config.valid']);
    expect(result.checks.find((c) => c.id === 'config.valid')?.status).toBe('fail');
    expect(result.overall).toBe('fail');
  });
});
