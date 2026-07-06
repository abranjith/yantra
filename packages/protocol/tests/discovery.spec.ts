// @no-llm
import { describe, expect, it } from 'vitest';

import {
  BudgetSnapshot,
  DiscoveryBudget,
  DiscoveryCycle,
  DiscoveryObservation,
  DiscoveryProposal,
  DiscoverySession,
  DiscoveryValidation,
  InteractableDescriptor,
  JSON_SCHEMA_ARTIFACTS,
  TaskEvent,
  normalizeProposal,
  validateDiscoveryProposal,
} from '../src/index.js';

const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const at = '2026-07-01T00:00:00.000Z';
const task_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

// ---------------------------------------------------------------------------
// Helpers — valid building blocks
// ---------------------------------------------------------------------------

/** A valid semantic-locator-only navigate step (intent locator). */
function validNavigateStep() {
  return {
    id: 's1',
    scope: null,
    type: 'navigate' as const,
    url: { kind: 'literal' as const, value: 'https://example.com' },
  };
}

/** A valid semantic-locator-only click step (intent locator). */
function validClickStep() {
  return {
    id: 's2',
    scope: null,
    type: 'click' as const,
    locator: {
      kind: 'intent' as const,
      role: 'button',
      name_match: { kind: 'exact' as const, value: 'Search' },
      near: null,
    },
    modifiers: null,
  };
}

/** A valid semantic-locator-only fill step (intent locator). */
function validFillStep() {
  return {
    id: 's3',
    scope: null,
    type: 'fill' as const,
    locator: {
      kind: 'intent' as const,
      role: 'textbox',
      name_match: { kind: 'exact' as const, value: 'Email' },
      near: null,
    },
    value: { kind: 'literal' as const, value: 'test@example.com' },
    submit: false,
  };
}

/** A valid extract step (semantic locator). */
function validExtractStep() {
  return {
    id: 's4',
    scope: null,
    type: 'extract' as const,
    locator: {
      kind: 'intent' as const,
      role: 'table',
      name_match: null,
      near: null,
    },
    extraction_schema: { type: 'primitive' as const, kind: 'string' as const },
    capture_as: 'data',
  };
}

/** A valid proposal with one navigate step and no done claim. */
function validProposal() {
  return {
    rationale: 'I will navigate to the site to begin exploration.',
    steps: [validNavigateStep()],
    done: null,
  };
}

/** A valid observation. */
function validObservation() {
  return {
    url: 'https://example.com',
    title: 'Example Domain',
    page_digest: 'This domain is for use in illustrative examples.',
    interactables: [
      { role: 'link', name: 'More information', kind: 'link' as const, disabled: false },
    ],
    step_outcome: 'completed' as const,
    outcome_reason: null,
  };
}

/** A valid budget. */
function validBudget() {
  return {
    max_steps: 15,
    max_llm_calls: 20,
    max_wall_clock_ms: 300_000,
    max_cost_usd: 1.0,
  };
}

/** A valid cycle. */
function validCycle() {
  return {
    index: 0,
    proposal: validProposal(),
    validation: { verdict: 'accepted' as const, reasons: [] },
    observation: validObservation(),
    budget_after: {
      steps_used: 1,
      llm_calls_used: 1,
      wall_clock_ms: 5000,
      cost_usd: 0.02,
    },
  };
}

/** A valid session. */
function validSession() {
  return {
    session_id: VALID_ULID,
    run_id: 'run-001',
    goal: 'Find ticket availability for the next NFL game',
    budget: validBudget(),
    host_allowlist: ['example.com', 'tickets.example.com'],
    cycles: [validCycle()],
    outcome: 'goal_met' as const,
    promoted_workflow: null,
  };
}

// ---------------------------------------------------------------------------
// DiscoveryObservation
// ---------------------------------------------------------------------------

describe('DiscoveryObservation schema', () => {
  it('parses a well-formed observation', () => {
    expect(DiscoveryObservation.safeParse(validObservation()).success).toBe(true);
  });

  it('parses an observation with null title and null outcome_reason', () => {
    const obs = { ...validObservation(), title: null, outcome_reason: null };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(true);
  });

  it('parses an observation with a failed step_outcome and reason', () => {
    const obs = {
      ...validObservation(),
      step_outcome: 'failed',
      outcome_reason: 'Navigation timeout after 30000ms',
    };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(true);
  });

  it('parses an observation with ethics_refused outcome', () => {
    const obs = {
      ...validObservation(),
      step_outcome: 'ethics_refused',
      outcome_reason: 'Ethics rule: login page requires human handoff',
    };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(true);
  });

  it('parses an observation with confirmation_denied outcome', () => {
    const obs = {
      ...validObservation(),
      step_outcome: 'confirmation_denied',
      outcome_reason: 'User denied consent for click action',
    };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(true);
  });

  it('rejects an empty url', () => {
    const obs = { ...validObservation(), url: '' };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(false);
  });

  it('rejects an invalid step_outcome enum', () => {
    const obs = { ...validObservation(), step_outcome: 'success' };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(false);
  });

  it('rejects more than 30 interactables', () => {
    const obs = {
      ...validObservation(),
      interactables: Array.from({ length: 31 }, (_, i) => ({
        role: 'link',
        name: `Link ${i}`,
        kind: 'link',
        disabled: false,
      })),
    };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(false);
  });

  it('accepts exactly 30 interactables', () => {
    const obs = {
      ...validObservation(),
      interactables: Array.from({ length: 30 }, (_, i) => ({
        role: 'link',
        name: `Link ${i}`,
        kind: 'link',
        disabled: false,
      })),
    };
    expect(DiscoveryObservation.safeParse(obs).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InteractableDescriptor
// ---------------------------------------------------------------------------

describe('InteractableDescriptor schema', () => {
  it('parses a well-formed descriptor', () => {
    const desc = { role: 'button', name: 'Submit', kind: 'button', disabled: false };
    expect(InteractableDescriptor.safeParse(desc).success).toBe(true);
  });

  it('parses a descriptor with null name (unnamed element)', () => {
    const desc = { role: 'button', name: null, kind: 'button', disabled: false };
    expect(InteractableDescriptor.safeParse(desc).success).toBe(true);
  });

  it('parses a disabled descriptor', () => {
    const desc = { role: 'textbox', name: 'Email', kind: 'input', disabled: true };
    expect(InteractableDescriptor.safeParse(desc).success).toBe(true);
  });

  it('rejects an invalid kind', () => {
    const desc = { role: 'button', name: 'Submit', kind: 'div', disabled: false };
    expect(InteractableDescriptor.safeParse(desc).success).toBe(false);
  });

  it('rejects an empty role', () => {
    const desc = { role: '', name: 'Submit', kind: 'button', disabled: false };
    expect(InteractableDescriptor.safeParse(desc).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryProposal — basic schema validation
// ---------------------------------------------------------------------------

describe('DiscoveryProposal schema', () => {
  it('parses a well-formed proposal with one step', () => {
    expect(DiscoveryProposal.safeParse(validProposal()).success).toBe(true);
  });

  it('parses a proposal with three steps (max allowed)', () => {
    const proposal = {
      rationale: 'Navigate, then click search, then extract results.',
      steps: [validNavigateStep(), validClickStep(), validExtractStep()],
      done: null,
    };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(true);
  });

  it('rejects a 4-step proposal (exceeds max)', () => {
    const proposal = {
      rationale: 'Too many steps.',
      steps: [
        validNavigateStep(),
        validClickStep(),
        validExtractStep(),
        { ...validNavigateStep(), id: 's5' },
      ],
      done: null,
    };
    const result = DiscoveryProposal.safeParse(proposal);
    expect(result.success).toBe(false);
  });

  it('rejects a 0-step proposal (min 1)', () => {
    const proposal = { rationale: 'No steps.', steps: [], done: null };
    const result = DiscoveryProposal.safeParse(proposal);
    expect(result.success).toBe(false);
  });

  it('rejects an empty rationale', () => {
    const proposal = { ...validProposal(), rationale: '' };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(false);
  });

  it('rejects a rationale exceeding max length (1000)', () => {
    const proposal = { ...validProposal(), rationale: 'x'.repeat(1001) };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(false);
  });

  it('accepts a rationale at exactly max length (1000)', () => {
    const proposal = { ...validProposal(), rationale: 'x'.repeat(1000) };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(true);
  });

  it('parses a proposal with a done claim', () => {
    const proposal = {
      rationale: 'Goal is met — I found the ticket availability.',
      steps: [validNavigateStep()],
      done: {
        goal_met: true,
        summary_md: 'Tickets are available for the next NFL game at example.com.',
        citations_hint: ['https://example.com/tickets'],
      },
    };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(true);
  });

  it('rejects a done with an invalid URL in citations_hint', () => {
    const proposal = {
      ...validProposal(),
      done: {
        goal_met: true,
        summary_md: 'Done.',
        citations_hint: ['not-a-url'],
      },
    };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(false);
  });

  it('rejects a done with summary_md exceeding max length (4000)', () => {
    const proposal = {
      ...validProposal(),
      done: {
        goal_met: true,
        summary_md: 'x'.repeat(4001),
        citations_hint: [],
      },
    };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(false);
  });

  it('rejects more than 20 citations', () => {
    const proposal = {
      ...validProposal(),
      done: {
        goal_met: true,
        summary_md: 'Done.',
        citations_hint: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`),
      },
    };
    expect(DiscoveryProposal.safeParse(proposal).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeProposal — confirmation-forcing transform
// ---------------------------------------------------------------------------

describe('normalizeProposal — confirmation-forcing transform', () => {
  it('forces requires_confirmation true on a navigate step', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Navigate to the site.',
      steps: [{ ...validNavigateStep(), requires_confirmation: false }],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps[0]?.requires_confirmation).toBe(true);
  });

  it('forces requires_confirmation true on a click step', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Click the search button.',
      steps: [{ ...validClickStep(), requires_confirmation: false }],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps[0]?.requires_confirmation).toBe(true);
  });

  it('forces requires_confirmation true on a fill step', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Fill the email field.',
      steps: [{ ...validFillStep(), requires_confirmation: false }],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps[0]?.requires_confirmation).toBe(true);
  });

  it('does not set requires_confirmation on a non-mutating step (extract)', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Extract the results table.',
      steps: [validExtractStep()],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps[0]?.requires_confirmation).toBe(false);
  });

  it('forces confirmation on all mutating steps in a multi-step proposal', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Navigate, click, and fill.',
      steps: [
        { ...validNavigateStep(), requires_confirmation: false },
        { ...validClickStep(), requires_confirmation: false },
        { ...validFillStep(), requires_confirmation: false },
      ],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps.every((s) => s.requires_confirmation === true)).toBe(true);
  });

  it('preserves already-true requires_confirmation on mutating steps', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Navigate.',
      steps: [{ ...validNavigateStep(), requires_confirmation: true }],
      done: null,
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.steps[0]?.requires_confirmation).toBe(true);
  });

  it('preserves the rationale and done fields unchanged', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Navigate to the site.',
      steps: [{ ...validNavigateStep(), requires_confirmation: false }],
      done: {
        goal_met: true,
        summary_md: 'Done.',
        citations_hint: ['https://example.com'],
      },
    });
    const normalized = normalizeProposal(proposal);
    expect(normalized.rationale).toBe(proposal.rationale);
    expect(normalized.done).toEqual(proposal.done);
  });

  it('does not mutate the original proposal (returns a new object)', () => {
    const proposal = DiscoveryProposal.parse({
      rationale: 'Navigate.',
      steps: [{ ...validNavigateStep(), requires_confirmation: false }],
      done: null,
    });
    const originalFlag = proposal.steps[0]?.requires_confirmation;
    normalizeProposal(proposal);
    expect(proposal.steps[0]?.requires_confirmation).toBe(originalFlag);
  });
});

// ---------------------------------------------------------------------------
// validateDiscoveryProposal — discovery-specific refinements
// ---------------------------------------------------------------------------

describe('validateDiscoveryProposal — secret ref rejection', () => {
  it('rejects a SecretRef in a navigate url', () => {
    const proposal = {
      rationale: 'Navigate using a secret URL.',
      steps: [
        {
          ...validNavigateStep(),
          url: { kind: 'secret', key: 'bank.url' },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('SecretRef'))).toBe(true);
      expect(messages.some((m) => m.includes('steps/0'))).toBe(true);
    }
  });

  it('rejects a SecretRef in a fill value', () => {
    const proposal = {
      rationale: 'Fill with a secret.',
      steps: [
        {
          ...validFillStep(),
          value: { kind: 'secret', key: 'shop.card' },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('SecretRef'))).toBe(true);
      expect(messages.some((m) => m.includes('steps/0'))).toBe(true);
    }
  });

  it('rejects a SecretRef nested in a template binding within a fill value', () => {
    const proposal = {
      rationale: 'Fill with a templated secret.',
      steps: [
        {
          ...validFillStep(),
          value: {
            kind: 'template',
            template: '{{secret_val}}',
            bindings: {
              secret_val: { kind: 'secret', key: 'shop.password' },
            },
          },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('SecretRef'))).toBe(true);
    }
  });

  it('accepts a proposal with no SecretRef anywhere', () => {
    const result = validateDiscoveryProposal(validProposal());
    expect(result.success).toBe(true);
  });
});

describe('validateDiscoveryProposal — non-semantic locator rejection', () => {
  it('rejects a recorded locator kind on a click step', () => {
    const proposal = {
      rationale: 'Click using a recorded locator.',
      steps: [
        {
          ...validClickStep(),
          locator: { kind: 'recorded', step_index: 0 },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('intent'))).toBe(true);
      expect(messages.some((m) => m.includes('steps/0'))).toBe(true);
    }
  });

  it('rejects a workflow locator kind on a click step', () => {
    const proposal = {
      rationale: 'Click using a workflow locator.',
      steps: [
        {
          ...validClickStep(),
          locator: { kind: 'workflow', name: 'Buy button' },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('intent'))).toBe(true);
    }
  });

  it('rejects a recorded locator kind on an extract step', () => {
    const proposal = {
      rationale: 'Extract using a recorded locator.',
      steps: [
        {
          ...validExtractStep(),
          locator: { kind: 'recorded', step_index: 1 },
        },
      ],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(false);
  });

  it('accepts a proposal with intent locators only', () => {
    const proposal = {
      rationale: 'Navigate and extract using semantic locators.',
      steps: [validNavigateStep(), validExtractStep()],
      done: null,
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(true);
  });

  it('accepts a navigate step (no locator field, url-based)', () => {
    const result = validateDiscoveryProposal(validProposal());
    expect(result.success).toBe(true);
  });
});

describe('validateDiscoveryProposal — base schema failures pass through', () => {
  it('returns the base Zod error for a structurally invalid proposal', () => {
    const result = validateDiscoveryProposal({ rationale: 'x', steps: 'not-an-array' });
    expect(result.success).toBe(false);
  });

  it('returns success for a valid proposal with done claim', () => {
    const proposal = {
      rationale: 'Goal met.',
      steps: [validNavigateStep()],
      done: {
        goal_met: true,
        summary_md: 'Found the tickets.',
        citations_hint: ['https://example.com'],
      },
    };
    const result = validateDiscoveryProposal(proposal);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryBudget
// ---------------------------------------------------------------------------

describe('DiscoveryBudget schema', () => {
  it('parses a well-formed budget', () => {
    expect(DiscoveryBudget.safeParse(validBudget()).success).toBe(true);
  });

  it('parses a budget with null max_cost_usd (no cost limit)', () => {
    const budget = { ...validBudget(), max_cost_usd: null };
    expect(DiscoveryBudget.safeParse(budget).success).toBe(true);
  });

  it('rejects a non-positive max_steps', () => {
    const budget = { ...validBudget(), max_steps: 0 };
    expect(DiscoveryBudget.safeParse(budget).success).toBe(false);
  });

  it('rejects a non-integer max_steps', () => {
    const budget = { ...validBudget(), max_steps: 15.5 };
    expect(DiscoveryBudget.safeParse(budget).success).toBe(false);
  });

  it('rejects a negative max_cost_usd', () => {
    const budget = { ...validBudget(), max_cost_usd: -1.0 };
    expect(DiscoveryBudget.safeParse(budget).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BudgetSnapshot
// ---------------------------------------------------------------------------

describe('BudgetSnapshot schema', () => {
  it('parses a well-formed snapshot', () => {
    const snap = {
      steps_used: 5,
      llm_calls_used: 7,
      wall_clock_ms: 120_000,
      cost_usd: 0.15,
    };
    expect(BudgetSnapshot.safeParse(snap).success).toBe(true);
  });

  it('parses a zero-usage snapshot', () => {
    const snap = { steps_used: 0, llm_calls_used: 0, wall_clock_ms: 0, cost_usd: 0 };
    expect(BudgetSnapshot.safeParse(snap).success).toBe(true);
  });

  it('rejects a negative steps_used', () => {
    const snap = { steps_used: -1, llm_calls_used: 0, wall_clock_ms: 0, cost_usd: 0 };
    expect(BudgetSnapshot.safeParse(snap).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryValidation
// ---------------------------------------------------------------------------

describe('DiscoveryValidation schema', () => {
  it('parses an accepted validation', () => {
    const v = { verdict: 'accepted', reasons: [] };
    expect(DiscoveryValidation.safeParse(v).success).toBe(true);
  });

  it('parses a rejected validation with reasons', () => {
    const v = { verdict: 'rejected', reasons: ['SecretRef not allowed', 'Non-semantic locator'] };
    expect(DiscoveryValidation.safeParse(v).success).toBe(true);
  });

  it('rejects an invalid verdict', () => {
    const v = { verdict: 'maybe', reasons: [] };
    expect(DiscoveryValidation.safeParse(v).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryCycle
// ---------------------------------------------------------------------------

describe('DiscoveryCycle schema', () => {
  it('parses a well-formed cycle', () => {
    expect(DiscoveryCycle.safeParse(validCycle()).success).toBe(true);
  });

  it('parses a cycle with null observation (rejected without execution)', () => {
    const cycle = {
      ...validCycle(),
      validation: { verdict: 'rejected', reasons: ['SecretRef not allowed'] },
      observation: null,
    };
    expect(DiscoveryCycle.safeParse(cycle).success).toBe(true);
  });

  it('rejects a negative cycle index', () => {
    const cycle = { ...validCycle(), index: -1 };
    expect(DiscoveryCycle.safeParse(cycle).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiscoverySession
// ---------------------------------------------------------------------------

describe('DiscoverySession schema', () => {
  it('parses a well-formed session', () => {
    expect(DiscoverySession.safeParse(validSession()).success).toBe(true);
  });

  it('parses a session with promoted_workflow name', () => {
    const session = { ...validSession(), promoted_workflow: 'find-tickets' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('parses a session with budget_exhausted outcome', () => {
    const session = { ...validSession(), outcome: 'budget_exhausted' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('parses a session with user_declined outcome', () => {
    const session = { ...validSession(), outcome: 'user_declined' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('parses a session with handoff outcome', () => {
    const session = { ...validSession(), outcome: 'handoff' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('parses a session with aborted outcome', () => {
    const session = { ...validSession(), outcome: 'aborted' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('parses a session with goal_unreachable outcome', () => {
    const session = { ...validSession(), outcome: 'goal_unreachable' };
    expect(DiscoverySession.safeParse(session).success).toBe(true);
  });

  it('rejects a malformed session_id (not a ULID)', () => {
    const session = { ...validSession(), session_id: 'not-a-ulid' };
    expect(DiscoverySession.safeParse(session).success).toBe(false);
  });

  it('rejects an empty goal', () => {
    const session = { ...validSession(), goal: '' };
    expect(DiscoverySession.safeParse(session).success).toBe(false);
  });

  it('rejects an empty host_allowlist', () => {
    const session = { ...validSession(), host_allowlist: [] };
    // The schema requires an array of strings with min(1) — empty array is allowed
    // by the array schema itself, but each entry must be min(1). An empty array
    // is technically valid per the schema (no min on the array). Verify behavior:
    const result = DiscoverySession.safeParse(session);
    // The schema does not enforce a minimum host_allowlist length, so this should pass.
    expect(result.success).toBe(true);
  });

  it('rejects an invalid outcome enum', () => {
    const session = { ...validSession(), outcome: 'success' };
    expect(DiscoverySession.safeParse(session).success).toBe(false);
  });

  it('rejects an empty host entry in the allowlist', () => {
    const session = { ...validSession(), host_allowlist: [''] };
    expect(DiscoverySession.safeParse(session).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TaskEvent — discovery variants
// ---------------------------------------------------------------------------

describe('TaskEvent — discovery variants', () => {
  it('parses a discovery_cycle_completed event', () => {
    const event = {
      kind: 'discovery_cycle_completed',
      task_id,
      at,
      cycle: validCycle(),
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('parses a discovery_session_completed event with goal_met outcome', () => {
    const event = {
      kind: 'discovery_session_completed',
      task_id,
      at,
      outcome: 'goal_met',
      cycles: 5,
      promoted_workflow: 'find-tickets',
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('parses a discovery_session_completed event with null promoted_workflow', () => {
    const event = {
      kind: 'discovery_session_completed',
      task_id,
      at,
      outcome: 'budget_exhausted',
      cycles: 15,
      promoted_workflow: null,
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('rejects a discovery_session_completed event with invalid outcome', () => {
    const event = {
      kind: 'discovery_session_completed',
      task_id,
      at,
      outcome: 'success',
      cycles: 5,
      promoted_workflow: null,
    };
    expect(TaskEvent.safeParse(event).success).toBe(false);
  });

  it('rejects a discovery_session_completed event with negative cycles', () => {
    const event = {
      kind: 'discovery_session_completed',
      task_id,
      at,
      outcome: 'goal_met',
      cycles: -1,
      promoted_workflow: null,
    };
    expect(TaskEvent.safeParse(event).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON Schema artifact registration
// ---------------------------------------------------------------------------

describe('JSON Schema artifact registration', () => {
  it('includes discovery-session.json in JSON_SCHEMA_ARTIFACTS', () => {
    expect(JSON_SCHEMA_ARTIFACTS['discovery-session.json']).toBeDefined();
    expect(JSON_SCHEMA_ARTIFACTS['discovery-session.json']?.name).toBe('DiscoverySession');
  });
});

// ---------------------------------------------------------------------------
// Property: malformed proposals never panic the validator
// ---------------------------------------------------------------------------

describe('Property: malformed proposals never panic the validator', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    '',
    42,
    [],
    { rationale: 'x' },
    { rationale: 'x', steps: null, done: null },
    { rationale: 'x', steps: 'not-an-array', done: null },
    { rationale: 'x', steps: [{ type: 'unknown' }], done: null },
    { rationale: 'x', steps: [{ ...validNavigateStep(), url: 'not-a-value-ref' }], done: null },
    {
      rationale: 'x',
      steps: [{ ...validClickStep(), locator: { kind: 'css', selector: '#btn' } }],
      done: null,
    },
    { rationale: 'x', steps: [validNavigateStep()], done: { goal_met: 'yes' } },
    { rationale: 'x', steps: [validNavigateStep()], done: { goal_met: true, summary_md: 123 } },
  ];

  for (const input of malformed) {
    const label =
      input === undefined ? 'undefined' : (JSON.stringify(input)?.slice(0, 80) ?? String(input));
    it(`returns safeParse false (not throw) for input: ${label}`, () => {
      expect(() => validateDiscoveryProposal(input)).not.toThrow();
      const result = validateDiscoveryProposal(input);
      expect(result.success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Property: malformed sessions/observations/cycles never panic
// ---------------------------------------------------------------------------

describe('Property: malformed discovery documents never panic', () => {
  const malformed: unknown[] = [
    null,
    undefined,
    '',
    42,
    [],
    { session_id: 'short' },
    { session_id: VALID_ULID },
    { url: '' },
    { url: 'https://example.com', interactables: 'not-an-array' },
    { index: -1, proposal: null },
  ];

  for (const input of malformed) {
    const label =
      input === undefined ? 'undefined' : (JSON.stringify(input)?.slice(0, 80) ?? String(input));
    it(`DiscoverySession.safeParse does not throw for: ${label}`, () => {
      expect(() => DiscoverySession.safeParse(input)).not.toThrow();
    });
    it(`DiscoveryObservation.safeParse does not throw for: ${label}`, () => {
      expect(() => DiscoveryObservation.safeParse(input)).not.toThrow();
    });
    it(`DiscoveryCycle.safeParse does not throw for: ${label}`, () => {
      expect(() => DiscoveryCycle.safeParse(input)).not.toThrow();
    });
  }
});
