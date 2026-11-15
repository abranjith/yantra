/**
 * Stop (FEAT-067 TASK-008): ends a run the app launched, through
 * `command.cancel {invocation_id}`. The host relays `cancel` over the run
 * socket; a command that cannot stop cleanly is ended after 10 s and
 * reconciled (FEAT-064).
 *
 * - The label says which before the press: "Stop" where the handler honors
 *   abort (protocol ABORT_RULES), "Stop (force)" elsewhere, with a tooltip
 *   saying what force means (spec DEVIATION-1).
 * - It is disabled while stopping, so a second press is never a second
 *   cancel, and it is never the default focus.
 * - A run the app did not launch has no Stop here (there is no invocation to
 *   cancel); its terminal owns it.
 */

import type { CommandInvocation } from '@yantra/protocol';
import { honorsAbort, parseInvocation, type InvocationFacts } from '@yantra/protocol/commands';
import { Button, Tooltip, TooltipTrigger } from '@yantra/ui';
import type { ReactNode } from 'react';

import type { CockpitState } from '../live/cockpit-state.js';

/** What force-stopping means, in words. */
export const FORCE_STOP_TEXT =
  'This command cannot stop cleanly yet. Yantra will end it after 10 seconds and record the run as interrupted.';

/**
 * Whether a Stop of this run is graceful. The invocation's options and the
 * host-resolved mode decide (`LLM_PROVIDER=none` makes a run deterministic
 * with no flag), refined by what the run has shown: deterministic phases mean
 * no model.
 */
export function stopIsGraceful(
  invocation: CommandInvocation,
  cockpit: CockpitState | null,
  /** The mode the host resolved for this invocation (flags, environment, preferences). */
  resolvedMode?: 'llm' | 'deterministic',
): boolean {
  const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
  });
  if (!parsed.isOk) return false;
  const deterministic =
    cockpit !== null &&
    cockpit.phase !== null &&
    cockpit.contract === null &&
    cockpit.openTools.length === 0 &&
    cockpit.timeline.total > 0 &&
    !hasToolRows(cockpit);
  const facts: InvocationFacts = {
    options: parsed.value.options,
    arguments: parsed.value.arguments,
    explicit: parsed.value.explicit,
    ...(deterministic
      ? { mode: 'deterministic' as const }
      : resolvedMode === undefined
        ? {}
        : { mode: resolvedMode }),
  };
  return honorsAbort(parsed.value.entry.id, facts);
}

function hasToolRows(cockpit: CockpitState): boolean {
  return cockpit.timeline.chunks.some((chunk) => chunk.some((row) => row.type === 'tool'));
}

export interface StopControlProps {
  readonly graceful: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
}

/** See the module comment. */
export function StopControl({ graceful, stopping, onStop }: StopControlProps): ReactNode {
  const button = (
    <Button
      size="sm"
      variant="secondary"
      icon="action.stop"
      isDisabled={stopping}
      onPress={onStop}
      data-stop={graceful ? 'graceful' : 'force'}
    >
      {stopping ? 'Stopping…' : graceful ? 'Stop' : 'Stop (force)'}
    </Button>
  );
  if (graceful) return button;
  return (
    <TooltipTrigger>
      {button}
      <Tooltip>{FORCE_STOP_TEXT}</Tooltip>
    </TooltipTrigger>
  );
}
