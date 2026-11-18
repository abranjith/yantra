import type { AppRpc } from '../host/app-rpc.js';

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
    executor.navigate(`/palette/${encodeURIComponent(outcome.command)}`);
    return;
  }
  await executor.rpc.request('command.invoke', {
    invocation: outcome.invocation,
    displayed_effective: { settings: [], content: [] },
  });
}
