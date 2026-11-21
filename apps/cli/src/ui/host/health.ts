/**
 * Host RPC handlers for Health (FEAT-071 TASK-006).
 *
 * `read.doctor` runs `collectDoctorResult` in-process (`read` class) and
 * validates the result against `DoctorResult` before sending. Unlike the
 * generic `read.*` wrapper, a `fail` check does not throw an RPC error: Health
 * renders failing checks directly.
 */

import { Writable } from 'node:stream';

import { runAgentDiagnostics, runAgentSmoke } from '@yantra/agent';
import {
  createKeychainProvider,
  doctor as runCoreDoctor,
  loadSearchConfig,
  readPossibleOrphans,
  runsRoot,
  yantraVersion,
  type KeychainProvider,
  type ProcessLivenessProbe,
} from '@yantra/core';
import {
  DoctorReadParams,
  DoctorResult,
  EmptyParams,
  HostEnvironmentInfo,
  PossibleOrphansResult,
  type PossibleOrphan,
} from '@yantra/protocol';

import { collectDoctorResult, type DoctorRuntime } from '../../commands/doctor.js';
import { loadEffectivePreferences } from '../../preferences.js';

import type { HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

export interface HealthDeps {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly logger?: HostLogger;
  readonly collect?: (options: { readonly refresh?: boolean }) => Promise<DoctorResult>;
  readonly hostStatus?: HostEnvironmentInfo;
  readonly probe?: ProcessLivenessProbe;
  readonly runsDir?: string;
  readonly readOrphans?: () => Promise<readonly PossibleOrphan[]>;
  readonly keychain?: () => Promise<KeychainProvider>;
}

const DISCARD = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function defaultRuntime(
  env: Readonly<NodeJS.ProcessEnv>,
  keychain?: () => Promise<KeychainProvider>,
): DoctorRuntime {
  return {
    env: { ...env },
    stdout: DISCARD,
    stderr: DISCARD,
    isTty: false,
    coreDoctor: runCoreDoctor,
    agentDiagnostics: runAgentDiagnostics,
    loadPreferences: loadEffectivePreferences,
    smoke: runAgentSmoke,
    runsRoot,
    keychain: keychain ?? createKeychainProvider,
    searchConfig: loadSearchConfig,
  };
}

/** Registers Health RPC methods on `methods`. */
export function registerHealth(methods: RpcMethodRegistry, deps: HealthDeps): void {
  const collect =
    deps.collect ??
    (async (options: { readonly refresh?: boolean }) =>
      collectDoctorResult(defaultRuntime(deps.env, deps.keychain), {
        refresh: options.refresh === true,
      }) as Promise<DoctorResult>);

  methods.register('read.doctor', {
    params: DoctorReadParams,
    result: DoctorResult,
    handler: async (params) => {
      const result = await collect({ refresh: params.refresh === true });
      const parsed = DoctorResult.safeParse(result);
      if (!parsed.success) {
        throw new RpcError(
          'internal_error',
          'Doctor result failed protocol schema validation.',
          'Check `yantra doctor --json` for details.',
        );
      }
      return parsed.data;
    },
  });

  const fallbackNow = new Date().toISOString();
  const hostStatus: HostEnvironmentInfo = deps.hostStatus ?? {
    host_started_at: fallbackNow,
    env_captured_at: fallbackNow,
    yantra_version: yantraVersion(),
    host_pid: process.pid,
  };

  methods.register('read.host_status', {
    params: EmptyParams,
    result: HostEnvironmentInfo,
    handler: () => Promise.resolve(HostEnvironmentInfo.parse(hostStatus)),
  });

  const readOrphans =
    deps.readOrphans ??
    (async () =>
      readPossibleOrphans({
        root: deps.runsDir ?? runsRoot(),
        ...(deps.probe === undefined ? {} : { probe: deps.probe }),
      }));

  methods.register('read.possible_orphans', {
    params: EmptyParams,
    result: PossibleOrphansResult,
    handler: async () => {
      const orphans = await readOrphans();
      return PossibleOrphansResult.parse({ orphans });
    },
  });
}
