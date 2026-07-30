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
 * Note on locator richness: the two promotion paths differ, and the difference
 * is load-bearing.
 *
 * `promoteAgentTrace` receives a chain the locator engine's own ranker derived
 * from the live element (`AgentBrowserController.locatorFor`) — testid, then
 * role + accessible name, then label/placeholder, then unique CSS, terminated
 * by an absolute XPath. That chain is expressed in the exact terms the replay
 * resolver uses, so a recorded role can never be one the resolver would not
 * compute for that element, and a single miss falls through to a narrower
 * candidate instead of failing the run.
 *
 * `promoteDiscoverySession` still promotes the model's own proposed `intent`
 * (role + name_match) as a one-entry chain: a discovery proposal names an
 * element it has not yet resolved, so there is no live element to rank. That
 * is the weaker of the two and is the remaining place to enrich once discovery
 * carries a resolved handle.
 */

import type {
  DiscoveryCycle,
  LocatorCandidate,
  LocatorChain,
  Step,
  ValueRef,
  WorkflowFile,
  WorkflowStep,
  WorkflowSynthesis,
} from '@yantra/protocol';
import { err, ok, type Result } from '@yantra/protocol';

import { lint } from '../workflow/lint/index.js';
import { WorkflowCollisionError } from '../workflow/store.js';
import type { WorkflowStore } from '../workflow/store.types.js';

// ---------------------------------------------------------------------------
// Agent-trace promotion (FEAT-027 TASK-004)
// ---------------------------------------------------------------------------

/**
 * A fill value recorded in an agent trace: a non-secret literal, or a website
 * secret *reference* (never the resolved value).
 */
export type PromotableFillValue =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'secret_ref'; readonly key: string };

/**
 * Structural shape of one recorded successful interaction. Mirrors the agent
 * runtime's `AgentTraceStep` so this module never imports `@yantra/agent`; the
 * agent passes its real trace steps in directly.
 */
export interface PromotableTraceStep {
  readonly kind: 'navigate' | 'click' | 'fill' | 'extract' | 'observe';
  readonly host: string;
  readonly url?: string;
  readonly locator?: readonly LocatorCandidate[];
  readonly value?: PromotableFillValue;
  readonly submit?: boolean;
  readonly extractionKind?: 'content' | 'table';
  readonly requires_confirmation: boolean;
}

/**
 * Collapses the trace's trailing run of reads into at most one, and drops every
 * read taken mid-run.
 *
 * An agentic run observes constantly — after each action, to decide the next
 * one. Those observations are navigation aids and must not each become a step.
 * The run's *final* read is different in kind: it is where the agent collected
 * the answer it reported back, and it is the step a replayed workflow needs in
 * order to produce anything at all.
 *
 * A run that ended by observing (rather than extracting) previously promoted to
 * a workflow that clicked through and captured nothing, because only extracts
 * became steps. Keeping the trailing read — as an extract, since replay has no
 * "observe" verb — is what gives the workflow an output.
 */
function withTerminalReadOnly(
  steps: readonly PromotableTraceStep[],
): readonly PromotableTraceStep[] {
  const isRead = (step: PromotableTraceStep): boolean =>
    step.kind === 'observe' || step.kind === 'extract';

  let end = steps.length;
  while (end > 0 && isRead(steps[end - 1]!)) end -= 1;

  const actions = steps.slice(0, end).filter((step) => !isRead(step));
  const trailing = steps.slice(end);
  if (trailing.length === 0) return actions;

  // Several trailing reads collapse to one. Prefer a real `browser_extract`
  // over an observation: the model asked for a typed extraction, and its
  // `extractionKind` says whether it wanted the content or the first table.
  const chosen = trailing.find((step) => step.kind === 'extract') ?? trailing[trailing.length - 1]!;
  return [...actions, { ...chosen, kind: 'extract' as const }];
}

/** Options for {@link promoteAgentTrace}. */
export interface PromoteTraceOptions {
  readonly workflowName: string;
  /** Workflow store to save through; the caller wires the real `FileWorkflowStore`. */
  readonly store: WorkflowStore;
  /** Optional human-readable description (defaults to a generic promoted note). */
  readonly description?: string;
  /** Overwrite an existing workflow of the same name (default false). */
  readonly force?: boolean;
  /**
   * The run's goal, carried into the promoted workflow's `synthesis:` block so
   * replaying it reproduces the *document* the original run published — not just
   * the raw capture the trailing read collected (FEAT-FP-001).
   *
   * Supply this only when the run actually published a Brief: a run that
   * published nothing had no synthesis step to reproduce, and declaring one
   * would promise a document the workflow was never shown how to produce.
   */
  readonly synthesisGoal?: string;
}

/** Schema cap on `synthesis.goal`; a longer goal is truncated, never rejected. */
const MAX_SYNTHESIS_GOAL_CHARS = 512;

/**
 * Builds the promoted workflow's synthesis block from the run's goal.
 *
 * Returns null when no goal was supplied or it is blank. An over-long goal is
 * truncated rather than dropped: promotion is best-effort and must never fail a
 * published run, and a clipped goal still describes the document far better than
 * no block at all.
 */
function synthesisFor(goal: string | undefined): WorkflowSynthesis | null {
  const trimmed = goal?.trim() ?? '';
  if (trimmed.length === 0) return null;

  return {
    goal: trimmed.slice(0, MAX_SYNTHESIS_GOAL_CHARS),
    length: 'medium',
    detail: 'standard',
  };
}

/**
 * Promotes a successful agent browser trace into a saved, replayable
 * `WorkflowFile`. Each trace step becomes a workflow step with a candidate-chain
 * locator; secret fills become `{{ secret:<key> }}` references with the key
 * declared in `workflow.secrets`; `requires_confirmation` flags are preserved.
 * The result is linted (strict) before saving — a lint failure returns a typed
 * error and never partially saves.
 *
 * When `synthesisGoal` is supplied, the promoted workflow also carries a
 * `synthesis:` block, so `yantra run <name>` ends in a Brief the way the original
 * `yantra do` run did instead of reporting the raw trailing capture.
 *
 * @param steps - The ordered successful interactions from an agentic run.
 * @param opts - Target workflow name, store, description, overwrite flag, and
 *   optional synthesis goal.
 * @returns The saved `WorkflowFile`, or a typed error (never throws).
 */
export async function promoteAgentTrace(
  steps: readonly PromotableTraceStep[],
  opts: PromoteTraceOptions,
): Promise<Result<WorkflowFile, PromoteError>> {
  if (steps.length === 0) {
    return err({
      kind: 'no_completed_steps',
      message: 'The agent trace has no successful interactions to promote.',
    });
  }

  const locators: Record<string, LocatorCandidate[]> = {};
  const secrets = new Set<string>();
  const workflowSteps: WorkflowStep[] = [];
  let stepCounter = 1;
  let extractCounter = 0;

  for (const step of withTerminalReadOnly(steps)) {
    const id = `s${stepCounter}`;
    const converted = convertTraceStep(step, id, locators, secrets, () => (extractCounter += 1));
    if (converted !== null) {
      workflowSteps.push(converted);
      stepCounter += 1;
    }
  }

  if (workflowSteps.length === 0) {
    return err({
      kind: 'no_completed_steps',
      message: 'The agent trace produced no convertible workflow steps.',
    });
  }

  const workflow: WorkflowFile = {
    version: 1,
    name: opts.workflowName,
    description: opts.description ?? 'Promoted from an agentic run.',
    security_class: secrets.size > 0 ? 'authenticated' : 'public',
    recorded_with: null,
    params: {},
    secrets: [...secrets].sort(),
    cookies: 'none',
    steps: workflowSteps,
    outputs: declareOutputs(workflowSteps),
    synthesis: synthesisFor(opts.synthesisGoal),
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
 * Converts one trace step into a workflow step, registering its candidate-chain
 * locator and (for secret fills) declaring the secret. Returns null for a step
 * that cannot be represented (never happens for the four supported kinds).
 */
function convertTraceStep(
  step: PromotableTraceStep,
  id: string,
  locators: Record<string, LocatorCandidate[]>,
  secrets: Set<string>,
  nextExtractIndex: () => number,
): WorkflowStep | null {
  switch (step.kind) {
    case 'navigate':
      return {
        id,
        verb: 'navigate',
        scope: null,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: step.url ?? '',
      };
    case 'click':
      return {
        id,
        verb: 'click',
        scope: null,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: registerCandidateChain(step.locator, id, locators),
      };
    case 'fill': {
      const value = step.value ?? { kind: 'literal', value: '' };
      if (value.kind === 'secret_ref') secrets.add(value.key);
      return {
        id,
        verb: 'fill',
        scope: null,
        requires_confirmation: step.requires_confirmation,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        locator: registerCandidateChain(step.locator, id, locators),
        value: value.kind === 'secret_ref' ? `{{ secret:${value.key} }}` : value.value,
        submit: step.submit ?? false,
      };
    }
    case 'extract': {
      const index = nextExtractIndex();
      const kind = step.extractionKind ?? 'content';
      const name = `${id}_locator`;
      // The agent extract tool has no located element, so synthesize a broad,
      // deterministic locator: the whole body for content, the first table for a
      // table. Replay re-extracts from the live page.
      locators[name] =
        kind === 'table' ? [{ kind: 'css', value: 'table' }] : [{ kind: 'css', value: 'body' }];
      return {
        id,
        verb: 'extract',
        scope: null,
        requires_confirmation: false,
        locator: name,
        // Content pairs the page-level locator with `readable`, not `string`:
        // the raw text of `body` is nav, cookie banner, footer, and inline
        // script source, which is not what the agent read and not what the user
        // asked for. `readable` runs the same Readability pass the agent's own
        // page digest uses.
        extraction_schema:
          kind === 'table'
            ? { type: 'array', items: { type: 'primitive', kind: 'string' } }
            : { type: 'primitive', kind: 'readable' },
        capture_as: `extracted_${kind}_${index}`,
      };
    }
    default:
      return null;
  }
}

/**
 * Declares one workflow output per captured extraction.
 *
 * Without this a promoted workflow captured its data and then discarded it:
 * `outputs` was always empty, so nothing reached `outputs.json` and `yantra
 * run` had nothing to show. A run that completes and reports nothing is
 * indistinguishable from one that did nothing.
 *
 * The binding unwraps the `ExtractionResultEnvelope` the executor stores, so
 * the output is the extracted value rather than `{rows, metadata}`: a
 * single-value extraction binds `rows[0]`, a table binds the whole `rows`
 * array. Both are ordinary JSONata against the `capture` scope, so the emitted
 * YAML stays readable and hand-editable.
 */
function declareOutputs(steps: readonly WorkflowStep[]): { name: string; from: string }[] {
  const outputs: { name: string; from: string }[] = [];
  for (const step of steps) {
    if (step.verb !== 'extract') continue;
    const rows = `capture.${step.capture_as}.rows`;
    outputs.push({
      name: step.capture_as,
      from: `{{ ${step.extraction_schema.type === 'array' ? rows : `${rows}[0]`} }}`,
    });
  }
  return outputs;
}

/** Registers a candidate chain under a fresh name and returns that name. */
function registerCandidateChain(
  chain: readonly LocatorCandidate[] | undefined,
  stepId: string,
  locators: Record<string, LocatorCandidate[]>,
): string {
  const name = `${stepId}_locator`;
  locators[name] =
    chain && chain.length > 0 ? [...chain] : [{ kind: 'role', role: 'button', name: '' }];
  return name;
}

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
    synthesis: null,
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
