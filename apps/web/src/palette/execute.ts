import type { AppRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';

const SURFACE_PATHS: Readonly<Record<string, string>> = {
  installation: '/settings/installation',
  preferences: '/settings/preferences',
  models: '/settings/models',
  sites: '/settings/sites',
  data: '/settings/data',
  browser: '/settings/browser',
  credentials: '/settings/credentials',
  health: '/health',
  onboarding: '/onboarding',
  daemon: '/daemon',
  workflows: '/workflows',
  templates: '/templates',
  schedules: '/schedules',
  usage: '/usage',
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
  if (outcome.command === 'secret set') {
    const key = outcome.invocation.argv.find((token) => !token.startsWith('-'));
    executor.navigate(
      key === undefined
        ? '/settings/credentials'
        : `/settings/credentials?key=${encodeURIComponent(key)}`,
    );
    return;
  }
  if (outcome.command === 'secret list' || outcome.command === 'secret rm') {
    executor.navigate('/settings/credentials');
    return;
  }
  if (outcome.command === 'init') {
    executor.navigate(
      outcome.invocation.argv.includes('--reset') ? '/onboarding?reset=1' : '/onboarding',
    );
    return;
  }
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
