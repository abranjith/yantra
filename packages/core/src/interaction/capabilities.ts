import type { InteractionFamily } from './escalation.js';
import { interactionMessage, type InteractionMessageSurface } from './messages.js';

/** One concrete engine receiver for advice emitted by an interaction family. */
export interface CapabilityReceiver {
  readonly surface: InteractionMessageSurface;
  readonly family: InteractionFamily;
  readonly capability: string;
  readonly receiver: string;
}

/** Total, auditable routing table for every engine-capability-bearing message. */
export const CAPABILITY_RECEIVERS = [
  {
    surface: 'fill',
    family: 'combobox',
    capability: 'selectByOfferedLabel',
    receiver: 'selectByOfferedLabel',
  },
  {
    surface: 'fill',
    family: 'date',
    capability: 'selectByOfferedLabel',
    receiver: 'selectByOfferedCalendarLabel',
  },
  {
    surface: 'fill',
    family: 'option',
    capability: 'selectByOfferedLabel',
    receiver: 'rankAgainstRequested',
  },
  {
    surface: 'fill',
    family: 'text',
    capability: 'selectByOfferedLabel',
    receiver: 'rankAgainstRequested',
  },
  { surface: 'fill', family: 'date', capability: 'probeOpen', receiver: 'probeOpen' },
  { surface: 'fill', family: 'option', capability: 'probeOpen', receiver: 'probeOpen' },
  { surface: 'fill', family: 'text', capability: 'locateEditee', receiver: 'locateEditee' },
  {
    surface: 'fill',
    family: 'combobox',
    capability: 'locateEditee',
    receiver: 'locateEditee',
  },
  {
    surface: 'actionability',
    family: 'option',
    capability: 'selectByOfferedLabel',
    receiver: 'AgentBrowserController.selectOption',
  },
] as const satisfies readonly CapabilityReceiver[];

/** Resolve the function (or class method) that receives one family's advice. */
export function receiverFor(
  surface: InteractionMessageSurface,
  family: InteractionFamily,
  capability: string,
  receivers: readonly CapabilityReceiver[] = CAPABILITY_RECEIVERS,
): string | null {
  return (
    receivers.find(
      (row) => row.surface === surface && row.family === family && row.capability === capability,
    )?.receiver ?? null
  );
}

/** A capability-bearing message escaped from a family with no declared receiver. */
export class UnreceivableAdviceError extends Error {
  public constructor(
    public readonly surface: InteractionMessageSurface,
    public readonly code: string,
    public override readonly cause: string,
    public readonly family: InteractionFamily,
  ) {
    super(`No receiver for (${surface}, ${family}) advice ${code}/${cause}.`);
    this.name = 'UnreceivableAdviceError';
  }
}

/** Fail loudly unless this exact emitting family has a concrete advice receiver. */
export function assertReceivable(
  surface: InteractionMessageSurface,
  code: string,
  cause: string,
  family: InteractionFamily,
  receivers: readonly CapabilityReceiver[] = CAPABILITY_RECEIVERS,
): void {
  const template = interactionMessage(surface, code, cause);
  if (template.capabilityKind !== 'engine' || template.capability === null) return;
  if (
    template.emittedBy?.includes(family) !== true ||
    receiverFor(surface, family, template.capability, receivers) === null
  ) {
    throw new UnreceivableAdviceError(surface, code, cause, family);
  }
}
