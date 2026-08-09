/**
 * Discovery sub-protocol schemas (FEAT-020).
 *
 * `yantra do "<goal>"` runs a bounded ReAct loop: the agent proposes a small
 * next step (1–3 standard protocol steps), the executor executes it, the
 * observation builder produces a sanitized observation, and the agent
 * re-plans — repeating under hard budgets until the goal is met, blocked,
 * or exhausted.
 *
 * Security invariants enforced at the schema level:
 *   - Proposal steps are **semantic-locator-only**: `LocatorChain` kinds
 *     `recorded` and `workflow` are rejected (no recording context exists in
 *     discovery, and workflow-named locators belong to saved workflows, not
 *     live proposals). Only `intent` locators (role + name_match) are allowed.
 *   - `SecretRef` is rejected anywhere in proposal step values — discovery
 *     has no secret access in this feature.
 *   - Mutating verbs (`navigate`, `click`, `fill`, `fill_element`) get `requires_confirmation`
 *     forced to `true` by the `normalizeProposal` transform, regardless of
 *     what the model set — defense in depth.
 *   - Bounded string lengths on `rationale` and `summary_md` to cap context.
 *
 * @see .spec-lite/features/feature_discovery_mode.md §2
 */

import { z } from 'zod';

import { ULID_PATTERN } from '../utils/ulid.js';

import { Step } from './steps.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Step verbs that mutate state and must always carry confirmation in discovery. */
const MUTATING_VERBS = new Set(['navigate', 'click', 'fill', 'fill_element']);

/** Maximum steps in a single discovery proposal. */
const MAX_PROPOSAL_STEPS = 3;

/** Maximum length of the model's rationale string (UTF-16 code units). */
const MAX_RATIONALE_LEN = 1_000;

/** Maximum length of the done summary Markdown. */
const MAX_SUMMARY_MD_LEN = 4_000;

/** Maximum interactable descriptors per observation. */
const MAX_INTERACTABLES = 30;

/** Maximum page digest length in characters. */
const MAX_PAGE_DIGEST_LEN = 8_000;

// ---------------------------------------------------------------------------
// InteractableDescriptor — sanitized element fingerprint for the model
// ---------------------------------------------------------------------------

export const InteractableDescriptor = z
  .object({
    role: z
      .string()
      .min(1)
      .max(50)
      .describe('ARIA role or semantic kind (e.g. "button", "link", "textbox").'),
    name: z
      .string()
      .max(200)
      .nullable()
      .describe('Accessible name or label, truncated to 200 chars. Null if unnamed.'),
    kind: z
      .enum(['button', 'link', 'input', 'select'])
      .describe('Coarse interaction kind for the model to reason about.'),
    disabled: z.boolean().describe('Whether the element is disabled or aria-disabled.'),
  })
  .describe('Sanitized descriptor of one interactable element on the page.');

export type InteractableDescriptor = z.infer<typeof InteractableDescriptor>;

// ---------------------------------------------------------------------------
// DiscoveryObservation — engine → model, post-sanitizer
// ---------------------------------------------------------------------------

export const DiscoveryStepOutcome = z
  .enum(['completed', 'failed', 'ethics_refused', 'confirmation_denied'])
  .describe('Typed outcome of the executed cycle steps.');

export type DiscoveryStepOutcome = z.infer<typeof DiscoveryStepOutcome>;

export const DiscoveryObservation = z
  .object({
    url: z.string().min(1).describe('Current page URL after cycle execution.'),
    title: z.string().max(300).nullable().describe('Page title or null if unavailable.'),
    page_digest: z
      .string()
      .max(MAX_PAGE_DIGEST_LEN)
      .describe('Sanitized + truncated extract of readable page content.'),
    interactables: z
      .array(InteractableDescriptor)
      .max(MAX_INTERACTABLES)
      .describe('Visible, enabled interactable elements (cap 30, ranked by prominence).'),
    step_outcome: DiscoveryStepOutcome.describe('Typed outcome of the cycle execution.'),
    outcome_reason: z
      .string()
      .max(500)
      .nullable()
      .describe(
        'Human-readable reason for the outcome (e.g. ethics rule, error message). Null on clean completion.',
      ),
  })
  .describe('Post-sanitizer observation of the current page state, sent to the model.');

export type DiscoveryObservation = z.infer<typeof DiscoveryObservation>;

// ---------------------------------------------------------------------------
// DiscoveryProposal — LLM output (untrusted, Zod-validated)
// ---------------------------------------------------------------------------

export const DiscoveryDone = z
  .object({
    goal_met: z.boolean().describe('Whether the agent believes the goal has been achieved.'),
    summary_md: z
      .string()
      .min(1)
      .max(MAX_SUMMARY_MD_LEN)
      .describe('Markdown summary of what was found or accomplished.'),
    citations_hint: z
      .array(z.string().url())
      .max(20)
      .describe('URLs of pages actually visited that support the summary claims.'),
  })
  .describe('Terminal claim — triggers Brief assembly when goal_met is true.');

export type DiscoveryDone = z.infer<typeof DiscoveryDone>;

export const DiscoveryProposal = z
  .object({
    rationale: z
      .string()
      .min(1)
      .max(MAX_RATIONALE_LEN)
      .describe("Model's stated reasoning for this cycle — audited, never executed."),
    steps: z
      .array(Step)
      .min(1)
      .max(MAX_PROPOSAL_STEPS)
      .describe('1–3 standard protocol steps to execute this cycle.'),
    done: DiscoveryDone.nullable().describe('Terminal claim, or null if the goal is not yet met.'),
  })
  .describe('Untrusted LLM proposal for one discovery cycle.');

export type DiscoveryProposal = z.infer<typeof DiscoveryProposal>;

// ---------------------------------------------------------------------------
// DiscoveryBudget — hard caps
// ---------------------------------------------------------------------------

export const DiscoveryBudget = z
  .object({
    max_steps: z
      .number()
      .int()
      .positive()
      .describe('Maximum total cycle steps before budget exhaustion.'),
    max_llm_calls: z
      .number()
      .int()
      .positive()
      .describe('Maximum LLM propose calls before budget exhaustion.'),
    max_wall_clock_ms: z.number().int().positive().describe('Wall-clock budget in milliseconds.'),
    max_cost_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Cost cap in USD, or null for no cost limit.'),
  })
  .describe('Hard budget caps for a discovery session.');

export type DiscoveryBudget = z.infer<typeof DiscoveryBudget>;

// ---------------------------------------------------------------------------
// DiscoveryCycle — one propose → act → observe turn
// ---------------------------------------------------------------------------

export const DiscoveryValidation = z
  .object({
    verdict: z.enum(['accepted', 'rejected']).describe('Whether the proposal passed validation.'),
    reasons: z.array(z.string()).describe('Rejection reasons (empty when accepted).'),
  })
  .describe('Validation outcome for a discovery proposal.');

export type DiscoveryValidation = z.infer<typeof DiscoveryValidation>;

export const BudgetSnapshot = z
  .object({
    steps_used: z.number().int().nonnegative().describe('Steps consumed so far.'),
    llm_calls_used: z.number().int().nonnegative().describe('LLM calls consumed so far.'),
    wall_clock_ms: z.number().int().nonnegative().describe('Wall clock elapsed in ms.'),
    cost_usd: z.number().nonnegative().describe('Cost consumed in USD.'),
  })
  .describe('Budget snapshot after a cycle.');

export type BudgetSnapshot = z.infer<typeof BudgetSnapshot>;

export const DiscoveryCycle = z
  .object({
    index: z.number().int().nonnegative().describe('0-based cycle index.'),
    proposal: DiscoveryProposal.describe('The (possibly normalized) proposal for this cycle.'),
    validation: DiscoveryValidation.describe('Validation verdict for the proposal.'),
    observation: DiscoveryObservation.nullable().describe(
      'Post-cycle observation, or null if the cycle was rejected without execution.',
    ),
    budget_after: BudgetSnapshot.describe('Budget snapshot after this cycle.'),
  })
  .describe('One propose → act → observe turn in a discovery session.');

export type DiscoveryCycle = z.infer<typeof DiscoveryCycle>;

// ---------------------------------------------------------------------------
// DiscoverySession — the full bounded ReAct run
// ---------------------------------------------------------------------------

export const DiscoveryOutcome = z
  .enum(['goal_met', 'goal_unreachable', 'budget_exhausted', 'user_declined', 'handoff', 'aborted'])
  .describe('Terminal outcome of a discovery session.');

export type DiscoveryOutcome = z.infer<typeof DiscoveryOutcome>;

export const DiscoverySession = z
  .object({
    session_id: z
      .string()
      .regex(ULID_PATTERN)
      .describe('Globally unique ULID for this discovery session.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    goal: z.string().min(1).describe('The user-supplied goal string.'),
    budget: DiscoveryBudget.describe('Hard budget caps.'),
    host_allowlist: z
      .array(z.string().min(1))
      .describe('Allowed hosts — navigation outside this set is blocked.'),
    cycles: z.array(DiscoveryCycle).describe('Ordered cycle history.'),
    outcome: DiscoveryOutcome.describe('Terminal outcome.'),
    promoted_workflow: z
      .string()
      .nullable()
      .describe('Workflow name if the path was promoted via --save-as, or null.'),
  })
  .describe('A complete bounded discovery session.');

export type DiscoverySession = z.infer<typeof DiscoverySession>;

// ---------------------------------------------------------------------------
// Normalizing transform — forces requires_confirmation on mutating verbs
// ---------------------------------------------------------------------------

/**
 * Forces `requires_confirmation: true` on any step with a mutating verb
 * (`navigate`, `click`, `fill`, `fill_element`), regardless of what the model set.
 *
 * This is defense in depth: even if the LLM sets `requires_confirmation: false`
 * on a click step, this transform overrides it so the executor's consent
 * gateway always fires. The executor gate is a second check — both must pass.
 *
 * @param proposal - The raw parsed proposal from the LLM.
 * @returns A new proposal with confirmation forced on mutating steps.
 */
export function normalizeProposal(proposal: DiscoveryProposal): DiscoveryProposal {
  return {
    ...proposal,
    steps: proposal.steps.map((step) => {
      if (MUTATING_VERBS.has(step.type)) {
        return { ...step, requires_confirmation: true };
      }
      return step;
    }),
  };
}

// ---------------------------------------------------------------------------
// Discovery-specific validation refinements
// ---------------------------------------------------------------------------

/**
 * Checks whether a ValueRef tree contains any `SecretRef`.
 * Discovery cannot reference secrets — this is a hard rejection.
 */
function containsSecretRef(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === 'secret') {
    return true;
  }
  // Recursively check template bindings
  if (obj.kind === 'template' && typeof obj.bindings === 'object' && obj.bindings !== null) {
    for (const binding of Object.values(obj.bindings as Record<string, unknown>)) {
      if (containsSecretRef(binding)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks whether a step uses a non-semantic locator kind.
 * Only `intent` locators (role + name_match) are allowed in discovery proposals.
 */
function usesNonSemanticLocator(step: unknown): boolean {
  if (step === null || typeof step !== 'object') {
    return false;
  }
  const obj = step as Record<string, unknown>;
  if (obj.locator !== null && typeof obj.locator === 'object') {
    const locator = obj.locator as Record<string, unknown>;
    if (locator.kind === 'recorded' || locator.kind === 'workflow') {
      return true;
    }
  }
  return false;
}

/**
 * Validates a discovery proposal with discovery-specific refinements:
 *   1. Rejects `SecretRef` anywhere in step values.
 *   2. Rejects non-semantic locator kinds (`recorded`, `workflow`).
 *
 * @returns `{ success: true, data }` on valid proposals, or
 *          `{ success: false, error }` with actionable paths on invalid ones.
 */
export function validateDiscoveryProposal(
  proposal: unknown,
): z.SafeParseReturnType<DiscoveryProposal, DiscoveryProposal> {
  // First: standard Zod parse
  const baseResult = DiscoveryProposal.safeParse(proposal);
  if (!baseResult.success) {
    return baseResult;
  }

  const data = baseResult.data;
  const reasons: string[] = [];

  // Check each step for secret refs and non-semantic locators
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i]!;
    const stepPath = `steps/${i}`;

    // Check for SecretRef in any value field
    if (step.type === 'navigate') {
      if (containsSecretRef(step.url)) {
        reasons.push(`${stepPath}/url: SecretRef is not allowed in discovery proposals`);
      }
    }
    if (step.type === 'fill' || step.type === 'fill_element') {
      if (containsSecretRef(step.value)) {
        reasons.push(`${stepPath}/value: SecretRef is not allowed in discovery proposals`);
      }
    }

    // Check for non-semantic locator kinds
    if (usesNonSemanticLocator(step)) {
      reasons.push(
        `${stepPath}/locator: only "intent" kind locators are allowed in discovery proposals (semantic locators only)`,
      );
    }
  }

  if (reasons.length > 0) {
    return {
      success: false,
      error: new z.ZodError(
        reasons.map((msg) => ({
          code: 'custom',
          path: [],
          message: msg,
        })),
      ),
    };
  }

  return { success: true, data };
}
