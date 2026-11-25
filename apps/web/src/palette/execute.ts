/**
 * Runs a command the palette understood (FEAT-070), then lands somewhere the
 * person can see what happened:
 *
 * - a read opens the page that shows it (`yantra list` opens the Ledger);
 * - a run (`ask`, `research`, `do`, `run`, `resume`) opens its live cockpit;
 * - any other change runs in a worker and opens the page it changes.
 */

import type { InvocationSummary } from '@yantra/protocol';

import type { AppRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';
import { SURFACE_DEFINITIONS } from '../surfaces/definitions.js';

import type { PaletteOutcome } from './palette-model.js';

/** Pages that are not generated surfaces, by the parity manifest's surface id. */
const PAGE_PATHS: Readonly<Record<string, string>> = {
  credentials: '/settings/credentials',
  health: '/health',
  onboarding: '/onboarding',
  inbox: '/inbox',
  ledger: '/runs',
  mission: '/mission',
};

/** Where a surface lives; a run's pages take the run ID typed after the command. */
export function surfacePath(surface: string, positionals: readonly string[]): string {
  const generated = SURFACE_DEFINITIONS.find((definition) => definition.id === surface);
  if (generated !== undefined) return generated.route;
  const runId = positionals[0];
  if (surface === 'run-result')
    return runId === undefined ? '/runs' : `/runs/${encodeURIComponent(runId)}`;
  if (surface === 'audit')
    return runId === undefined ? '/runs' : `/runs/${encodeURIComponent(runId)}/audit`;
  return PAGE_PATHS[surface] ?? '/mission';
}

/** What running a command did. */
export type PaletteResult =
  | { readonly kind: 'navigated'; readonly path: string }
  | { readonly kind: 'started'; readonly path: string; readonly invocationId: string | null };

export interface PaletteExecutor {
  readonly rpc: AppRpc;
  readonly navigate: (path: string) => void;
}

function go(executor: PaletteExecutor, path: string): PaletteResult {
  executor.navigate(path);
  return { kind: 'navigated', path };
}

/** Runs `outcome` when it is ready; returns what happened, or null when it is not. */
export async function executePalette(
  outcome: PaletteOutcome,
  executor: PaletteExecutor,
): Promise<PaletteResult | null> {
  if (outcome.state !== 'ready') return null;
  const positionals = outcome.invocation.argv.filter((token) => !token.startsWith('-'));
  if (outcome.command === 'secret set') {
    const key = positionals[0];
    return go(
      executor,
      key === undefined
        ? '/settings/credentials'
        : `/settings/credentials?key=${encodeURIComponent(key)}`,
    );
  }
  if (outcome.command === 'secret list' || outcome.command === 'secret rm') {
    return go(executor, '/settings/credentials');
  }
  if (outcome.command === 'init') {
    return go(
      executor,
      outcome.invocation.argv.includes('--reset') ? '/onboarding?reset=1' : '/onboarding',
    );
  }
  const target = PARITY_MANIFEST.commands[outcome.command];
  const surface =
    target?.kind === 'surface' || target?.kind === 'adapter' ? target.surface : undefined;
  if (outcome.executionClass === 'read') {
    return surface === undefined ? null : go(executor, surfacePath(surface, positionals));
  }
  const summary = await executor.rpc.request<Partial<InvocationSummary> | undefined>(
    'command.invoke',
    {
      invocation: outcome.invocation,
      displayed_effective: { settings: [], content: [] },
    },
  );
  const invocationId = typeof summary?.invocation_id === 'string' ? summary.invocation_id : null;
  const path =
    surface === 'mission' && invocationId !== null
      ? `/mission/invocations/${invocationId}`
      : surface === undefined
        ? '/runs'
        : surfacePath(surface, positionals);
  executor.navigate(path);
  return { kind: 'started', path, invocationId };
}
