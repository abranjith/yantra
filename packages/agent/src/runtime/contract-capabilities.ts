/**
 * Which declared contract items this run can deliver at all (FEAT-054,
 * FEAT-058).
 *
 * `task_contract` reports a gap the moment an item is declared, so a run that
 * cannot take the requested screenshot says so up front instead of discovering
 * it at publication. The same resolver tells the fulfillment evaluation why an
 * uncaptured artifact was unmet.
 *
 * Since FEAT-058 the only producer that meets a screenshot item is the local
 * deliverable capture (`browser_capture`), which captures every scope. Vision
 * Assist availability no longer affects artifact items (S7): a marked image is
 * not a clean deliverable, and a deliverable must never depend on a grant.
 */

import type { ArtifactScope } from '@yantra/protocol';

import type { CapabilityDecision, DeliverableReason } from './capture-capability.js';
import { artifactLabel } from './task-contract.js';

/** Why a declared artifact cannot be produced in this run. */
export type CaptureGapReason = DeliverableReason;

/** Resolves whether the run can capture a screenshot of a given scope. */
export interface ContractCapabilityResolver {
  /** Null when a capture of `scope` is possible, else the reason it is not. */
  captureGap(scope: ArtifactScope): CaptureGapReason | null;
}

/**
 * The default resolver, backed by the deliverable capture decision: every
 * scope is capturable iff deliverable capture is available; otherwise each
 * scope carries the decision's first reason code.
 */
export function deliverableContractCapabilities(
  deliverable: CapabilityDecision<DeliverableReason>,
): ContractCapabilityResolver {
  return {
    captureGap: () =>
      deliverable.available ? null : (deliverable.reasons[0] ?? 'suppressed_by_flag'),
  };
}

/**
 * The one-line disclosure shown the moment a declared screenshot is known to
 * be undeliverable (FEAT-058). ASCII punctuation only, so no terminal or log
 * can mangle it.
 */
export function capabilityGapLine(scope: ArtifactScope, reason: CaptureGapReason): string {
  const why =
    reason === 'suppressed_by_flag'
      ? 'Screenshots are off for this run (--no-screenshots)'
      : reason === 'no_browser'
        ? 'No browser is available in this run'
        : 'This command cannot act on pages';
  return `Cannot deliver: ${artifactLabel(scope)}. ${why}; continuing with the other requirements.`;
}

/**
 * The plain-words reason a screenshot item is unmet for a capability gap, as
 * the Brief's requirement and the terminal's `Partial:` line read it.
 */
export function captureGapPhrase(reason: CaptureGapReason): string {
  switch (reason) {
    case 'suppressed_by_flag':
      return 'screenshots are off for this run (--no-screenshots)';
    case 'no_browser':
      return 'no browser was available';
    case 'no_interaction_tools':
      return 'this command cannot act on pages';
  }
}
