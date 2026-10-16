/**
 * Which declared contract items this run can deliver at all (FEAT-054).
 *
 * `task_contract` reports a gap the moment an item is declared, so a run that
 * cannot take the requested screenshot says so up front instead of discovering
 * it at publication. The same resolver tells the fulfillment evaluation why an
 * uncaptured artifact was unmet.
 *
 * Until FEAT-058 adds a local deliverable capture, the only capture producer is
 * Vision Assist (`browser_screenshot`), which captures the viewport or one
 * element. FEAT-058 replaces the resolver; the evaluator does not change.
 */

import type { ArtifactScope } from '@yantra/protocol';

import { visionUnavailableReason, type VisionAvailability } from './vision.js';

/** Why a declared artifact cannot be produced in this run. */
export type CaptureGapReason =
  | 'scope_unsupported'
  | NonNullable<ReturnType<typeof visionUnavailableReason>>;

/** Resolves whether the run can capture a screenshot of a given scope. */
export interface ContractCapabilityResolver {
  /** Null when a capture of `scope` is possible, else the reason it is not. */
  captureGap(scope: ArtifactScope): CaptureGapReason | null;
}

/** Scopes `browser_screenshot` can capture. */
const VISION_SCOPES: ReadonlySet<ArtifactScope> = new Set(['viewport', 'element']);

/**
 * The default resolver, backed by Vision Assist availability: `viewport` and
 * `element` are capturable iff Vision Assist is available, and `full_page` is
 * never capturable (`scope_unsupported`).
 */
export function visionContractCapabilities(vision: VisionAvailability): ContractCapabilityResolver {
  return {
    captureGap: (scope) => {
      if (!VISION_SCOPES.has(scope)) return 'scope_unsupported';
      return visionUnavailableReason(vision);
    },
  };
}
