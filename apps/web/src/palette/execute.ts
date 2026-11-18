import type { AppRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';

const SURFACE_PATHS: Readonly<Record<string, string>> = {
  installation: '/settings/installation',
  preferences: '/settings/preferences',
  models: '/settings/models',
  sites: '/settings/sites',
  data: '/settings/data',
  browser: '/settings/browser',
  daemon: '/system/daemon',
  workflows: '/library/workflows',
  templates: '/library/templates',
  schedules: '/library/schedules',
  usage: '/system/usage',
  inbox: '/inbox',
  runs: '/runs',
  composer: '/composer',
  audit: '/system/audit',
  update: '/system/update',
};

import type { PaletteOutcome } from './palette-model.js';

export interface PaletteExecutor {
  readonly rpc: AppRpc;
  readonly navigate: (path: string) => void;
}
export async function executePalette(
  outcome: PaletteOutcome,
  executor: PaletteExecutor,
): Promise<void> {
  if (outcome.state !== 'ready') return;
  if (outcome.executionClass === 'read') {
    const target = PARITY_MANIFEST.commands[outcome.command];
    if (target?.kind !== 'surface') return;
    executor.navigate(SURFACE_PATHS[target.surface] ?? '/');
    return;
  }
  await executor.rpc.request('command.invoke', {
    invocation: outcome.invocation,
    displayed_effective: { settings: [], content: [] },
  });
}
