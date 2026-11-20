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
  runsRoot,
} from '@yantra/core';
import { DoctorReadParams, DoctorResult } from '@yantra/protocol';

import { collectDoctorResult, type DoctorRuntime } from '../../commands/doctor.js';
import { loadEffectivePreferences } from '../../preferences.js';

import type { HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

export interface HealthDeps {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly logger?: HostLogger;
  readonly collect?: (options: { readonly refresh?: boolean }) => Promise<DoctorResult>;
}

const DISCARD = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function defaultRuntime(env: Readonly<NodeJS.ProcessEnv>): DoctorRuntime {
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
    keychain: createKeychainProvider,
    searchConfig: loadSearchConfig,
  };
}

/** Registers Health RPC methods on `methods`. */
export function registerHealth(methods: RpcMethodRegistry, deps: HealthDeps): void {
  const collect =
    deps.collect ??
    (async (options: { readonly refresh?: boolean }) =>
      collectDoctorResult(defaultRuntime(deps.env), {
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
}
