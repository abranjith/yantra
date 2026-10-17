/**
 * Per-item fulfillment, judged from evidence (FEAT-054).
 *
 * Every declared contract item is `met`, `unmet`, or `not_applicable`, decided
 * only by what the run recorded: the action ledger (verified fills, executed
 * and refused clicks, captures), FEAT-053's delivery checks for the
 * deliverable, and the reconciled conditions for each filter. The model's
 * `fulfillment.met` is compared against the result; a disagreement becomes a
 * Brief notice and never changes an item's status.
 *
 * Pure: no I/O, no clock. The fill item is measured against the engine's form
 * census (TASK-006); until a census source exists it is never `met`.
 */

import type { FillCensus } from '@yantra/core';
import type {
  ArtifactScope,
  BriefNotice,
  BriefRequirement,
  FillExemption,
  TaskContractBody,
} from '@yantra/protocol';
import { BRIEF_MAX_REQUIREMENTS, artifactRequirementId } from '@yantra/protocol';

import type {
  ActionLedgerEntry,
  CaptureEntry,
  CommittedActionEntry,
  FillCommittedEntry,
} from './action-ledger.js';
import type { CaptureGapReason } from './contract-capabilities.js';
import {
  boundedNotice,
  normalizeDeliveryName,
  type DeliveryConstraint,
} from './contract-delivery.js';
import type { AgenticCommand } from './profiles.js';
import {
  artifactLabel,
  hostSatisfiesRequiredSource,
  renderActionPhrase,
  type EffectiveActionTerms,
} from './task-contract.js';

/** Longest requirement label. */
const MAX_LABEL = 120;

/** Longest requirement reason. */
const MAX_REASON = 200;

/** One declared requirement and what the evidence showed. */
export interface RequirementStatus {
  readonly id: string;
  readonly label: string;
  readonly status: 'met' | 'unmet' | 'not_applicable';
  /** What the evidence showed, or null when nothing needs saying. */
  readonly reason: string | null;
  /** The contract revision that declared it, or null when not tracked. */
  readonly declaredIn: number | null;
  /** Controls the engine judged exempt from a fill requirement. */
  readonly exemptions?: readonly { readonly label: string; readonly reason: FillExemption }[];
  /** How many more exempt controls exist beyond {@link exemptions}. */
  readonly exemptOverflow?: number;
}

/** The whole evaluation of one publication. */
export interface FulfillmentEvaluation {
  readonly items: readonly RequirementStatus[];
  /** Items met (not-applicable items excluded). */
  readonly met: number;
  /** Items judged (not-applicable items excluded). */
  readonly total: number;
  /** Whether the run declared a contract at all. */
  readonly contractDeclared: boolean;
  /** The notice raised when the model claimed every item met and evidence disagrees. */
  readonly disagreement: BriefNotice | null;
}

/** How the fill item is judged; TASK-006 supplies the census-backed version. */
export type FillEvaluator = (
  fill: NonNullable<EffectiveActionTerms['fill']>,
  ledger: readonly ActionLedgerEntry[],
) => Omit<RequirementStatus, 'id' | 'label' | 'declaredIn'>;

/** Everything one evaluation reads. */
export interface FulfillmentInput {
  readonly command: AgenticCommand;
  /** The current contract revision, or null when none was declared. */
  readonly contract: TaskContractBody | null;
  /** The action terms in force across every revision. */
  readonly terms: EffectiveActionTerms;
  /** Gaps in the published content against the deliverable (FEAT-053). */
  readonly deliverableGaps: readonly string[];
  /** Every declared condition, reconciled against the evidence (FEAT-053). */
  readonly constraints: readonly DeliveryConstraint[];
  /** Every verified action outcome, in record order. */
  readonly ledger: readonly ActionLedgerEntry[];
  /** The model's `fulfillment.met` claim, or null when it sent none. */
  readonly claimedMet: boolean | null;
  /** Why a capture of a scope is impossible in this run, or null when it is possible. */
  readonly captureGap: (scope: ArtifactScope) => CaptureGapReason | null;
  /** How the fill item is judged. */
  readonly evaluateFill: FillEvaluator;
}

/** The fill evaluator used when no form census exists: never `met`. */
export const UNAVAILABLE_FILL: FillEvaluator = () => ({
  status: 'unmet',
  reason: 'fields not counted (inventory_unavailable)',
});

/** Most exemptions an item lists before counting the rest. */
const MAX_EXEMPTIONS = 20;

/**
 * The fill evaluator measured against the engine's form census (TASK-006).
 *
 * - `all_eligible`: every eligible control (grouped controls count once)
 *   needs a verified commit on the census document, matched by ref or group.
 *   No census, an incomplete one, or a census of a different document than
 *   the last fill is never `met`.
 * - `listed`: every listed name needs a commit whose resolved field name
 *   matches it under FEAT-053's name grammar.
 *
 * Exempt controls are listed on the item, bounded with an overflow count.
 */
export function censusFillEvaluator(census: FillCensus | null): FillEvaluator {
  return (fill, ledger) => {
    const commits = ledger.filter(
      (entry): entry is FillCommittedEntry => entry.kind === 'fill_committed',
    );
    if (fill.coverage === 'listed') return listedFill(fill.fields, commits);
    if (census === null) return UNAVAILABLE_FILL(fill, ledger);
    const exemptions = exemptionsOf(census);
    if (!census.complete) {
      return {
        status: 'unmet',
        reason: 'fields not counted (inventory_incomplete)',
        ...exemptions,
      };
    }
    const lastFill = commits.at(-1);
    if (lastFill !== undefined && lastFill.epoch !== census.epoch) {
      return { status: 'unmet', reason: 'fields not counted (form_document_left)', ...exemptions };
    }
    const units = new Map<string, Set<string>>();
    for (const control of census.controls) {
      if (control.exemption !== null) continue;
      const key = control.groupKey === null ? `ref:${control.ref}` : `group:${control.groupKey}`;
      const refs = units.get(key) ?? new Set<string>();
      refs.add(control.ref);
      units.set(key, refs);
    }
    if (units.size === 0) {
      return { status: 'unmet', reason: 'no eligible fields were found', ...exemptions };
    }
    const onCensus = commits.filter((entry) => entry.epoch === census.epoch);
    let filled = 0;
    for (const [key, refs] of units) {
      const group = key.startsWith('group:') ? key.slice('group:'.length) : null;
      const committed = onCensus.some(
        (entry) => refs.has(entry.ref) || (group !== null && entry.groupKey === group),
      );
      if (committed) filled += 1;
    }
    return {
      status: filled === units.size ? 'met' : 'unmet',
      reason: `fields ${filled} of ${units.size} filled`,
      ...exemptions,
    };
  };
}

function listedFill(
  fields: readonly string[],
  commits: readonly FillCommittedEntry[],
): Omit<RequirementStatus, 'id' | 'label' | 'declaredIn'> {
  const filled = new Set(commits.map((entry) => normalizeDeliveryName(entry.field)));
  const missing = fields.filter((field) => !filled.has(normalizeDeliveryName(field)));
  return missing.length === 0
    ? { status: 'met', reason: `fields ${fields.length} of ${fields.length} filled` }
    : {
        status: 'unmet',
        reason: `fields ${fields.length - missing.length} of ${fields.length} filled; not filled: ${missing.join(', ')}`,
      };
}

function exemptionsOf(
  census: FillCensus,
): Pick<RequirementStatus, 'exemptions' | 'exemptOverflow'> {
  const seen = new Set<string>();
  const exempt: { label: string; reason: FillExemption }[] = [];
  for (const control of census.controls) {
    if (control.exemption === null) continue;
    const key = control.groupKey ?? `ref:${control.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    exempt.push({
      label: bound(control.label.length > 0 ? control.label : control.ref, MAX_LABEL),
      reason: control.exemption,
    });
  }
  if (exempt.length === 0) return {};
  return {
    exemptions: exempt.slice(0, MAX_EXEMPTIONS),
    ...(exempt.length > MAX_EXEMPTIONS ? { exemptOverflow: exempt.length - MAX_EXEMPTIONS } : {}),
  };
}

/**
 * Judges every declared item from evidence.
 *
 * Order: the deliverable, each filter, the fill, each artifact, then
 * `effects.submit`. A run with no contract has no items and
 * `contractDeclared: false`.
 */
export function evaluateFulfillment(input: FulfillmentInput): FulfillmentEvaluation {
  const { contract } = input;
  if (contract === null) {
    return { items: [], met: 0, total: 0, contractDeclared: false, disagreement: null };
  }
  const items: RequirementStatus[] = [
    deliverableItem(input, contract),
    ...contract.filters.map((filter) => filterItem(filter, input.constraints)),
  ];
  const { fill } = input.terms;
  if (fill !== null) {
    items.push({
      id: 'fill',
      label: renderActionPhrase({ ...input.terms, artifacts: [], submit: noSubmitTerm }) ?? 'fill',
      declaredIn: fill.declaredIn,
      ...input.evaluateFill(fill, input.ledger),
    });
  }
  for (const artifact of input.terms.artifacts) {
    items.push({
      id: artifactRequirementId(artifact.scope),
      label: artifactLabel(artifact.scope),
      declaredIn: artifact.declaredIn,
      ...artifactStatus(artifact.scope, input),
    });
  }
  if (input.terms.submit.value === 'forbidden') {
    items.push({
      id: 'effects.submit',
      label: 'do not submit',
      declaredIn: input.terms.submit.declaredIn,
      ...submitStatus(input.ledger),
    });
  }
  const bounded = uniqueIds(items).slice(0, BRIEF_MAX_REQUIREMENTS).map(boundItem);
  const judged = bounded.filter((item) => item.status !== 'not_applicable');
  const met = judged.filter((item) => item.status === 'met').length;
  return {
    items: bounded,
    met,
    total: judged.length,
    contractDeclared: true,
    disagreement: disagreementNotice(input.claimedMet, bounded),
  };
}

/** The Brief's `requirements` for an evaluation (snake_case, schema-bounded). */
export function toBriefRequirements(evaluation: FulfillmentEvaluation): BriefRequirement[] {
  return evaluation.items.map((item) => ({
    id: item.id,
    label: item.label,
    status: item.status,
    reason: item.reason,
    declared_in: item.declaredIn,
    ...(item.exemptions === undefined ? {} : { exemptions: [...item.exemptions] }),
    ...(item.exemptOverflow === undefined ? {} : { exempt_overflow: item.exemptOverflow }),
  }));
}

/**
 * One phrase per unmet item for a terminal line or a notice: the fill item's
 * own count, "<artifact> <reason>", or "<label>: <reason>".
 */
export function unmetPhrase(item: Pick<RequirementStatus, 'id' | 'label' | 'reason'>): string {
  const reason = item.reason ?? 'not met';
  if (item.id === 'fill') return reason;
  if (item.id.startsWith('artifact:')) return `${item.label} ${reason}`;
  return `${item.label}: ${reason}`;
}

/** The model-visible one-liner, such as `2 of 3 met; viewport screenshot not captured`. */
export function fulfillmentSummary(evaluation: FulfillmentEvaluation): string {
  if (!evaluation.contractDeclared) return 'no task contract was declared';
  const unmet = evaluation.items.filter((item) => item.status === 'unmet').map(unmetPhrase);
  return [`${evaluation.met} of ${evaluation.total} met`, ...unmet].join('; ').slice(0, 400);
}

const noSubmitTerm: EffectiveActionTerms['submit'] = { value: 'allowed', declaredIn: null };

function deliverableItem(input: FulfillmentInput, contract: TaskContractBody): RequirementStatus {
  const base = {
    id: 'deliverable',
    label: `${contract.deliverable} of ${contract.subject}`,
    declaredIn: null,
  };
  switch (contract.deliverable) {
    case 'table':
      return input.deliverableGaps.length === 0
        ? { ...base, status: 'met', reason: null }
        : { ...base, status: 'unmet', reason: input.deliverableGaps.join('; ') };
    case 'answer':
    case 'report': {
      const sourceGaps = input.deliverableGaps.filter((gap) =>
        gap.startsWith('nothing in the answer is cited from'),
      );
      return sourceGaps.length === 0
        ? { ...base, status: 'met', reason: null }
        : { ...base, status: 'unmet', reason: sourceGaps.join('; ') };
    }
    case 'actions':
      return { ...base, ...actionsStatus(input.ledger, contract) };
  }
}

function actionsStatus(
  ledger: readonly ActionLedgerEntry[],
  contract: TaskContractBody,
): Pick<RequirementStatus, 'status' | 'reason'> {
  const committed = ledger.filter(isCommitted);
  if (committed.length === 0) return { status: 'unmet', reason: 'no page action was recorded' };
  if (contract.required_sources.length === 0) return { status: 'met', reason: null };
  const offHost = [
    ...new Set(
      committed
        .filter((entry) => !hostSatisfiesRequiredSource(`https://${entry.host}/`, contract))
        .map((entry) => entry.host || 'an unknown page'),
    ),
  ];
  return offHost.length === 0
    ? { status: 'met', reason: null }
    : {
        status: 'unmet',
        reason: `actions happened on ${offHost.join(', ')}, not ${contract.required_sources.join(', ')}`,
      };
}

function filterItem(
  filter: TaskContractBody['filters'][number],
  constraints: readonly DeliveryConstraint[],
): RequirementStatus {
  const base = {
    id: `filter:${normalizeDeliveryName(filter.name) || filter.name.trim()}`.slice(0, 67),
    label: `${filter.name} = ${filter.value}`,
    declaredIn: null,
  };
  const condition = constraints.find(
    (entry) => normalizeDeliveryName(entry.name) === normalizeDeliveryName(filter.name),
  );
  switch (condition?.status) {
    case 'verified':
      return { ...base, status: 'met', reason: null };
    case 'violated':
      return { ...base, status: 'unmet', reason: `not met: ${condition.cause ?? condition.value}` };
    default:
      return {
        ...base,
        status: 'unmet',
        reason: `not confirmed${condition?.cause === undefined ? '' : ` (${condition.cause})`}`,
      };
  }
}

/** Which capture scopes satisfy a requested scope. */
function satisfies(requested: ArtifactScope, captured: ArtifactScope): boolean {
  return requested === 'viewport'
    ? captured === 'viewport' || captured === 'full_page'
    : captured === requested;
}

function artifactStatus(
  scope: ArtifactScope,
  input: FulfillmentInput,
): Pick<RequirementStatus, 'status' | 'reason'> {
  const captures = input.ledger.filter(
    (entry): entry is CaptureEntry => entry.kind === 'capture' && satisfies(scope, entry.scope),
  );
  if (captures.length === 0) {
    const gap = input.captureGap(scope);
    return { status: 'unmet', reason: gap === null ? 'not captured' : `not captured (${gap})` };
  }
  const last = lastCommitted(input.ledger);
  if (last === null) return { status: 'met', reason: null };
  const after = captures.filter((entry) => entry.seq > last.seq);
  if (after.length === 0) {
    return { status: 'unmet', reason: 'captured before the last page action' };
  }
  return after.some((entry) => entry.epoch === last.epoch)
    ? { status: 'met', reason: null }
    : { status: 'unmet', reason: 'captured on a different page than the last action' };
}

function submitStatus(
  ledger: readonly ActionLedgerEntry[],
): Pick<RequirementStatus, 'status' | 'reason'> {
  const executed = ledger.filter(
    (entry) => entry.kind === 'click_executed' && entry.submitClass !== null,
  ).length;
  const refused = ledger.filter((entry) => entry.kind === 'submit_refused').length;
  if (executed > 0) {
    return {
      status: 'unmet',
      reason: `${executed} submit-class click${executed === 1 ? ' was' : 's were'} executed`,
    };
  }
  return {
    status: 'met',
    reason: refused === 0 ? null : `${refused} submit attempt${refused === 1 ? '' : 's'} refused`,
  };
}

function disagreementNotice(
  claimedMet: boolean | null,
  items: readonly RequirementStatus[],
): BriefNotice | null {
  if (claimedMet !== true) return null;
  const unmet = items.filter((item) => item.status === 'unmet');
  if (unmet.length === 0) return null;
  return {
    kind: 'contract_gap',
    source: 'fulfillment',
    reason: boundedNotice(
      'The agent reported every requirement met; evidence shows: ',
      unmet.map(unmetPhrase),
      5,
    ),
  };
}

function isCommitted(entry: ActionLedgerEntry): entry is CommittedActionEntry {
  return entry.kind === 'fill_committed' || entry.kind === 'click_executed';
}

function lastCommitted(ledger: readonly ActionLedgerEntry[]): CommittedActionEntry | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]!;
    if (isCommitted(entry)) return entry;
  }
  return null;
}

/**
 * Gives every item a distinct id. Two filter names the contract keeps apart
 * ("drive-train", "drive train") can normalize to the same id; the later one
 * gets a numeric suffix rather than colliding in the Brief.
 */
function uniqueIds(items: readonly RequirementStatus[]): RequirementStatus[] {
  const seen = new Set<string>();
  return items.map((item) => {
    let id = item.id;
    for (let n = 2; seen.has(id); n += 1) id = `${item.id.slice(0, 64)} ${n}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

function boundItem(item: RequirementStatus): RequirementStatus {
  return {
    ...item,
    label: bound(item.label, MAX_LABEL),
    reason: item.reason === null ? null : bound(item.reason, MAX_REASON),
  };
}

function bound(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * The run's fulfillment evaluation, set once by the publication that produced
 * it and read by the orchestrator to decide the task outcome.
 */
export class FulfillmentRecord {
  private evaluation: FulfillmentEvaluation | null = null;

  /** Stores the evaluation of the run's one successful publication. */
  public record(evaluation: FulfillmentEvaluation): void {
    this.evaluation = evaluation;
  }

  /** The stored evaluation, or null when nothing was evaluated. */
  public current(): FulfillmentEvaluation | null {
    return this.evaluation;
  }
}
