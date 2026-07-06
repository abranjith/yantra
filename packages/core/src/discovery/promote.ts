/**
 * Workflow promotion — `yantra do --save-as <name>` (FEAT-020 TASK-005).
 *
 * Walks a successful discovery trace and turns it into a saved,
 * lint-clean, replayable `WorkflowFile`: only `completed` cycles are kept
 * (rejected/failed/ethics-refused/confirmation-denied dead-ends are
 * dropped), each proposed step's semantic `intent` locator becomes a named
 * `_locators` entry (role + name_match — see the module-level note on why
 * this is the semantic locator rather than a richer engine-resolved
 * candidate chain), and `requires_confirmation`/`confirmation_description`/
 * `expected_cost`/`consequence` are preserved verbatim.
 *
 * Takes a **structural** `PromotableSession` shape (not `@yantra/agent`'s
 * `DiscoverySessionState` type) so this module never imports `agent` — the
 * two are structurally identical; `apps/cli`'s `do.ts` passes its real
 * session state in directly.
 *
 * Note on locator richness: the spec's ideal is "the engine-resolved winning
 * candidate chain" from a live `LocatorResolutionEvent` — richer than the
 * model's own proposed intent. No production code path yet constructs a real
 * `InjectedScriptHost` from a live page (see `do.ts`'s module doc and
 * `.spec-lite/TODO.md`), so no such event is ever emitted for a discovery
 * cycle today; this promotes the model's own `intent` locator faithfully
 * instead. Once that gap closes, this is the one place to wire the richer
 * candidate in.
 */

import type {
  DiscoveryCycle,
  LocatorCandidate,
  LocatorChain,
  Step,
  ValueRef,
  WorkflowFile,
  WorkflowStep,
} from '@yantra/protocol';
import { err, ok, type Result } from '@yantra/protocol';

import { lint } from '../workflow/lint/index.js';
import { WorkflowCollisionError } from '../workflow/store.js';
import type { WorkflowStore } from '../workflow/store.types.js';

/** The structural shape this module needs from a discovery session. */
export interface PromotableSession {
  readonly goal: string;
  readonly cycles: readonly DiscoveryCycle[];
}

/** Options for {@link promoteDiscoverySession}. */
export interface PromoteOptions {
  readonly workflowName: string;
  /** Workflow store to save through; the caller wires the real `FileWorkflowStore`. */
  readonly store: WorkflowStore;
  /** Overwrite an existing workflow of the same name (default false — collision errors). */
  readonly force?: boolean;
}

/** Failure returned (never thrown) by {@link promoteDiscoverySession}. */
export type PromoteError =
  | { readonly kind: 'no_completed_steps'; readonly message: string }
  | { readonly kind: 'lint_failed'; readonly message: string; readonly errors: readonly string[] }
  | { readonly kind: 'name_collision'; readonly message: string }
  | { readonly kind: 'save_failed'; readonly message: string };

/**
 * Promotes a successful discovery trace into a saved `WorkflowFile`.
 *
 * @param session - The discovery session's goal + cycle history.
 * @param opts - The target workflow name, store, and overwrite flag.
 * @returns The saved `WorkflowFile` (already lint-clean), or a typed error.
 */
export async function promoteDiscoverySession(
  session: PromotableSession,
  opts: PromoteOptions,
): Promise<Result<WorkflowFile, PromoteError>> {
  const completedCycles = session.cycles.filter(
    (cycle) => cycle.observation !== null && cycle.observation.step_outcome === 'completed',
  );

  if (completedCycles.length === 0) {
    return err({
      kind: 'no_completed_steps',
      message: 'No completed cycles to promote — every cycle was rejected, failed, or blocked.',
    });
  }

  const locators: Record<string, LocatorCandidate[]> = {};
  const steps: WorkflowStep[] = [];
  let stepCounter = 1;

  for (const cycle of completedCycles) {
    for (const protocolStep of cycle.proposal.steps) {
      const workflowStep = convertStep(protocolStep, `s${stepCounter}`, locators);
      if (workflowStep !== null) {
        steps.push(workflowStep);
        stepCounter += 1;
      }
    }
  }

  if (steps.length === 0) {
    return err({
      kind: 'no_completed_steps',
      message: 'Completed cycles produced no convertible steps.',
    });
  }

  const workflow: WorkflowFile = {
    version: 1,
    name: opts.workflowName,
    description: `Promoted from discovery: ${session.goal}`,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps,
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: locators,
  };

  const report = lint(workflow, { strict: true });
  if (report.errors.length > 0) {
    return err({
      kind: 'lint_failed',
      message: `Promoted workflow failed lint (${report.errors.length} error(s)).`,
      errors: report.errors.map((finding) => `${finding.code}: ${finding.message}`),
    });
  }

  try {
    await opts.store.save(workflow, { force: opts.force ?? false });
  } catch (error) {
    if (error instanceof WorkflowCollisionError) {
      return err({ kind: 'name_collision', message: error.message });
    }
    return err({
      kind: 'save_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return ok(workflow);
}

/**
 * Converts one protocol `Step` into a `WorkflowStep`, registering an intent
 * locator (if present) under a fresh `_locators` name. Returns null for step
 * types discovery never proposes (branch/loop/call_workflow/llm_summarize —
 * excluded from the prompt catalog in TASK-002) or for a literal value that
 * cannot be represented as a plain workflow scalar (never happens today,
 * since discovery only ever proposes `{kind:'literal'}` values).
 */
function convertStep(
  step: Step,
  id: string,
  locators: Record<string, LocatorCandidate[]>,
): WorkflowStep | null {
  switch (step.type) {
    case 'navigate': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'navigate',
        scope: step.scope,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: step.confirmation_description,
        expected_cost: step.expected_cost,
        consequence: step.consequence,
        url: literalToScalar(step.url),
      };
      return workflowStep;
    }
    case 'click': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'click',
        scope: step.scope,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: step.confirmation_description,
        expected_cost: step.expected_cost,
        consequence: step.consequence,
        locator: registerLocator(step.locator, id, locators),
      };
      return workflowStep;
    }
    case 'fill': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'fill',
        scope: step.scope,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: step.confirmation_description,
        expected_cost: step.expected_cost,
        consequence: step.consequence,
        locator: registerLocator(step.locator, id, locators),
        value: literalToScalar(step.value),
        submit: step.submit,
      };
      return workflowStep;
    }
    case 'extract': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'extract',
        scope: step.scope,
        requires_confirmation: false,
        locator: registerLocator(step.locator, id, locators),
        extraction_schema: step.extraction_schema,
        capture_as: step.capture_as,
      };
      return workflowStep;
    }
    case 'wait_for': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'wait_for',
        scope: step.scope,
        requires_confirmation: false,
        locator: registerLocator(step.locator, id, locators),
        state: step.state,
        timeout_ms: step.timeout_ms,
      };
      return workflowStep;
    }
    case 'assert': {
      const workflowStep: WorkflowStep = {
        id,
        verb: 'assert',
        scope: step.scope,
        requires_confirmation: false,
        locator: registerLocator(step.locator, id, locators),
        condition: step.condition,
      };
      return workflowStep;
    }
    default:
      // branch/loop/call_workflow/llm_summarize never appear in a discovery
      // proposal (excluded from the prompt catalog) — defensively skip.
      return null;
  }
}

/** Registers an `intent` locator under a fresh name and returns that name. */
function registerLocator(
  locator: LocatorChain,
  stepId: string,
  locators: Record<string, LocatorCandidate[]>,
): string {
  const name = `${stepId}_locator`;
  if (locator.kind === 'intent') {
    const nameMatch = locator.name_match;
    const candidate: LocatorCandidate = {
      kind: 'role',
      role: locator.role,
      name:
        nameMatch === null
          ? ''
          : nameMatch.kind === 'exact'
            ? nameMatch.value
            : { pattern: nameMatch.pattern, flags: nameMatch.flags },
    };
    locators[name] = [candidate];
  }
  return name;
}

/** Extracts the scalar value from a discovery-proposed literal ValueRef. */
function literalToScalar(ref: ValueRef): string | number | boolean | null {
  return ref.kind === 'literal' ? ref.value : null;
}
