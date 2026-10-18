/**
 * The task-fidelity scenario catalogue (FEAT-049).
 *
 * Every scenario module in this directory is registered here exactly once; the
 * census asserts the registration in both directions (every file registered,
 * every registered id unique), so a scenario cannot be written and forgotten.
 */

import type { Scenario, Tier } from '../scenario.js';

import { articleQuestion } from './article-question.js';
import { article } from './article.js';
import { budgetExhaustion } from './budget-exhaustion.js';
import { captureElementBelowFold } from './capture-element-below-fold.js';
import { captureFullPageTall } from './capture-full-page-tall.js';
import { captureFullPageTruncated } from './capture-full-page-truncated.js';
import { captureLatched } from './capture-latched.js';
import { captureSuppressed } from './capture-suppressed.js';
import { captureTextOnly } from './capture-text-only.js';
import { captureVisionUnchanged } from './capture-vision-unchanged.js';
import { challengeLargeMain } from './challenge-large-main.js';
import { challengeRequiredSource } from './challenge-required-source.js';
import { challengeSmall } from './challenge-small.js';
import { contractDeclared } from './contract-declared.js';
import { contractInvalid } from './contract-invalid.js';
import { contractMissing } from './contract-missing.js';
import { doClaimsMetContrary } from './do-claims-met-contrary.js';
import { doContractMissing } from './do-contract-missing.js';
import { doFormComplete } from './do-form-complete.js';
import { doFormHistorical } from './do-form-historical.js';
import { doFulfillmentOmitted } from './do-fulfillment-omitted.js';
import { doRevisionDropsScreenshot } from './do-revision-drops-screenshot.js';
import { doSubmitForbidden } from './do-submit-forbidden.js';
import { handAssembledUrl } from './hand-assembled-url.js';
import { listingClientRendered } from './listing-client-rendered.js';
import { listingStructured } from './listing-structured.js';
import { listingTableFaults } from './listing-table-faults.js';
import { listingTable } from './listing-table.js';
import { multiTable } from './multi-table.js';
import { publishAlternatives } from './publish-alternatives.js';
import { publishBadReference } from './publish-bad-reference.js';
import { publishFlaggedValue } from './publish-flagged-value.js';
import { publishUnverifiedFilter } from './publish-unverified-filter.js';
import { repeatRead } from './repeat-read.js';
import { researchBrowse } from './research-browse.js';
import { researchNoBrowse } from './research-no-browse.js';
import { searchBreaker } from './search-breaker.js';
import { searchConcurrency } from './search-concurrency.js';
import { searchEmptyTimeout } from './search-empty-timeout.js';

/** Modules in this directory that hold shared code, not a scenario. */
export const HELPER_MODULES: readonly string[] = Object.freeze([
  'index',
  'common',
  'challenge',
  'do-form',
  'capture-common',
]);

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  listingTable,
  listingStructured,
  listingClientRendered,
  challengeSmall,
  challengeLargeMain,
  article,
  multiTable,
  publishAlternatives,
  publishBadReference,
  publishUnverifiedFilter,
  publishFlaggedValue,
  searchConcurrency,
  searchBreaker,
  searchEmptyTimeout,
  budgetExhaustion,
  repeatRead,
  handAssembledUrl,
  contractDeclared,
  contractMissing,
  doFormHistorical,
  doFormComplete,
  doClaimsMetContrary,
  doFulfillmentOmitted,
  doRevisionDropsScreenshot,
  doSubmitForbidden,
  doContractMissing,
  captureTextOnly,
  captureSuppressed,
  captureLatched,
  captureFullPageTall,
  captureFullPageTruncated,
  captureElementBelowFold,
  captureVisionUnchanged,
  contractInvalid,
  researchBrowse,
  researchNoBrowse,
  // Agentic tier only.
  challengeRequiredSource,
  articleQuestion,
  listingTableFaults,
]);

/** The scenarios that run in `tier`, in catalogue order. */
export function scenariosFor(tier: Tier): readonly Scenario[] {
  return SCENARIOS.filter((scenario) => scenario.tiers.includes(tier));
}

/** The scenario registered under `id`; throws for an unregistered id. */
export function scenarioNamed(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`no task-fidelity scenario named ${id}`);
  return found;
}
