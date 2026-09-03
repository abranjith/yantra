/**
 * Locator engine barrel. The only path external code should import from
 * within packages/core/src/locator/.
 */

export { LocatorResolverImpl } from './resolver.js';
export { resolveActionable } from './auto-wait.js';
export { PuppeteerInjectedScriptHost } from './injected-host.js';
// rankCandidates is browser-side (requires DOM). Import from ./ranking.js directly in browser/test contexts.
export { encodeIntent, decodeIntent } from './intent-codec.js';
export {
  LocatorNotFoundError,
  LocatorAmbiguousError,
  LocatorNotActionableError,
  FrameDetachedError,
  LocatorInvalidSelectorError,
} from './errors.js';

export type {
  AriaRole,
  RelativeRelation,
  LocatorIntent,
  EngineLocatorCandidate,
  EngineLocatorChain,
  CandidateAttempt,
  ResolveResult,
  SuccessResolveResult,
  ActionableState,
  HitTargetCheckResult,
  ResolveOptions,
  ActionableOptions,
  CandidateRanking,
  RankedCandidate,
  RankingOptions,
  JsonLocatorIntent,
  JsonRegex,
  InjectedScriptHost,
  InjectedAPI,
  LocatorResolutionEvent,
  LocatorEventSink,
} from './types.js';
