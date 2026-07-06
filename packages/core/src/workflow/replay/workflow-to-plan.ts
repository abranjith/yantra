/**
 * Workflow → Plan translator.
 *
 * Converts a persisted `WorkflowFile` into the in-memory `Plan` the executor
 * consumes, plus a `LocatorTable` for named locator resolution, output
 * bindings, and the resolved `ProfileSpec`.
 *
 * @example
 * const result = translate(workflow, resolvedParams);
 * // result.plan  — ready for Executor.run()
 * // result.locatorTable — passed to ExecutionContext.workflowLocators
 */

import type {
  BranchCondition,
  CaptureRef,
  LocatorCandidate,
  LocatorChain,
  Plan,
  Step,
  ValueRef,
  WorkflowFile,
  WorkflowStep,
} from '@yantra/protocol';
import { SCHEMA_VERSION, validateSemantics } from '@yantra/protocol';

import type { AriaRole, EngineLocatorCandidate, EngineLocatorChain } from '../../locator/types.js';

import { cookieModeToProfileSpec } from './cookies-mode.js';
import { WorkflowTranslationError } from './errors.js';
import type { LocatorTable, OutputBinding, TranslatedWorkflow } from './types.js';

// ---------------------------------------------------------------------------
// Expression parsers
// ---------------------------------------------------------------------------

const SECRET_EXPR = /^\{\{\s*secret:([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}$/;
const PARAM_EXPR = /^\{\{\s*param:([a-z][a-z0-9_]*)\s*\}\}$/;
const CAPTURE_EXPR = /^\{\{\s*capture:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\s*\}\}$/;

/** Converts a `WorkflowValueExpression` to a protocol `ValueRef`. */
function exprToValueRef(raw: string | number | boolean | null): ValueRef {
  if (typeof raw !== 'string') {
    return { kind: 'literal', value: raw };
  }

  const secretMatch = SECRET_EXPR.exec(raw);
  if (secretMatch) {
    return { kind: 'secret', key: secretMatch[1]! };
  }

  const paramMatch = PARAM_EXPR.exec(raw);
  if (paramMatch) {
    return { kind: 'param', key: paramMatch[1]! };
  }

  const captureMatch = CAPTURE_EXPR.exec(raw);
  if (captureMatch) {
    const ref = captureMatch[1]!;
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
      return { kind: 'capture', step_id: ref, field: null };
    }
    return { kind: 'capture', step_id: ref.slice(0, dotIdx), field: ref.slice(dotIdx + 1) };
  }

  return { kind: 'literal', value: raw };
}

/** Parses a capture expression string to a `CaptureRef`. */
function exprToCaptureRef(raw: string, context: string): CaptureRef {
  const captureMatch = CAPTURE_EXPR.exec(raw);
  if (captureMatch) {
    const ref = captureMatch[1]!;
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
      return { kind: 'capture', step_id: ref, field: null };
    }
    return { kind: 'capture', step_id: ref.slice(0, dotIdx), field: ref.slice(dotIdx + 1) };
  }
  throw new WorkflowTranslationError(
    'INVALID_CAPTURE_REF',
    `${context}: expected a {{ capture:... }} expression but got "${raw}".`,
  );
}

/** Parses a param/capture expression string to a `CaptureRef | ParamRef`. */
function exprToCollectionRef(
  raw: string,
  context: string,
): { kind: 'capture'; step_id: string; field: string | null } | { kind: 'param'; key: string } {
  const captureMatch = CAPTURE_EXPR.exec(raw);
  if (captureMatch) {
    const ref = captureMatch[1]!;
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
      return { kind: 'capture', step_id: ref, field: null };
    }
    return { kind: 'capture', step_id: ref.slice(0, dotIdx), field: ref.slice(dotIdx + 1) };
  }
  const paramMatch = PARAM_EXPR.exec(raw);
  if (paramMatch) {
    return { kind: 'param', key: paramMatch[1]! };
  }
  throw new WorkflowTranslationError(
    'INVALID_COLLECTION_REF',
    `${context}: expected a {{ capture:... }} or {{ param:... }} expression but got "${raw}".`,
  );
}

/** Parses a branch condition string to a `BranchCondition`. */
function exprToBranchCondition(raw: string, context: string): BranchCondition {
  if (raw === 'always') return { kind: 'always' };
  const captureMatch = CAPTURE_EXPR.exec(raw);
  if (captureMatch) {
    const ref = captureMatch[1]!;
    const dotIdx = ref.indexOf('.');
    const step_id = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
    const field = dotIdx === -1 ? null : ref.slice(dotIdx + 1);
    return { kind: 'capture_exists', capture: { kind: 'capture', step_id, field } };
  }
  throw new WorkflowTranslationError(
    'INVALID_BRANCH_CONDITION',
    `${context}: unsupported branch condition "${raw}". ` +
      `Use "always" or {{ capture:stepId }} / {{ capture:stepId.field }}.`,
  );
}

// ---------------------------------------------------------------------------
// LocatorCandidate → EngineLocatorCandidate
// ---------------------------------------------------------------------------

function workflowCandidateToEngine(c: LocatorCandidate): EngineLocatorCandidate {
  switch (c.kind) {
    case 'role': {
      const name = typeof c.name === 'string' ? c.name : new RegExp(c.name.pattern, c.name.flags);
      return {
        intent: { kind: 'role', role: c.role as AriaRole, name },
        source: 'authored',
      };
    }
    case 'testid':
      return { intent: { kind: 'testid', value: c.value }, source: 'authored' };
    case 'label':
      return { intent: { kind: 'label', text: c.value }, source: 'authored' };
    case 'placeholder':
      return { intent: { kind: 'placeholder', text: c.value }, source: 'authored' };
    case 'css':
      return { intent: { kind: 'css', selector: c.value }, source: 'authored' };
    case 'xpath':
      return { intent: { kind: 'xpath', expression: c.value }, source: 'authored' };
  }
}

function buildLocatorTable(locators: Record<string, LocatorCandidate[]>): LocatorTable {
  const table: LocatorTable = {};
  for (const [name, candidates] of Object.entries(locators)) {
    const engineCandidates: EngineLocatorChain = {
      name,
      candidates: candidates.map(workflowCandidateToEngine),
      strict: true,
    };
    table[name] = engineCandidates;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Step translation
// ---------------------------------------------------------------------------

function workflowLocator(name: string): LocatorChain {
  return { kind: 'workflow', name };
}

function translateStep(wfStep: WorkflowStep, stepId: string): Step {
  const base = {
    id: stepId,
    scope: wfStep.scope,
    requires_confirmation: wfStep.requires_confirmation,
  };

  switch (wfStep.verb) {
    case 'navigate':
      return {
        ...base,
        confirmation_description: wfStep.confirmation_description,
        expected_cost: wfStep.expected_cost,
        consequence: wfStep.consequence,
        type: 'navigate',
        url: exprToValueRef(wfStep.url),
      };

    case 'click':
      return {
        ...base,
        confirmation_description: wfStep.confirmation_description,
        expected_cost: wfStep.expected_cost,
        consequence: wfStep.consequence,
        type: 'click',
        locator: workflowLocator(wfStep.locator),
        modifiers: null,
      };

    case 'fill':
      return {
        ...base,
        confirmation_description: wfStep.confirmation_description,
        expected_cost: wfStep.expected_cost,
        consequence: wfStep.consequence,
        type: 'fill',
        locator: workflowLocator(wfStep.locator),
        value: exprToValueRef(wfStep.value),
        submit: wfStep.submit,
      };

    case 'extract':
      return {
        ...base,
        type: 'extract',
        locator: workflowLocator(wfStep.locator),
        extraction_schema: wfStep.extraction_schema,
        capture_as: wfStep.capture_as,
      };

    case 'wait_for':
      return {
        ...base,
        type: 'wait_for',
        locator: workflowLocator(wfStep.locator),
        state: wfStep.state,
        timeout_ms: wfStep.timeout_ms,
      };

    case 'assert':
      return {
        ...base,
        type: 'assert',
        locator: workflowLocator(wfStep.locator),
        condition: wfStep.condition,
      };

    case 'branch':
      return {
        ...base,
        type: 'branch',
        condition: exprToBranchCondition(wfStep.condition, `step ${stepId}`),
        then_step_id: wfStep.then_step_id,
        else_step_id: wfStep.else_step_id,
      };

    case 'loop':
      return {
        ...base,
        type: 'loop',
        over: exprToCollectionRef(wfStep.over, `step ${stepId} over`),
        as: wfStep.as,
        body_step_ids: wfStep.body_step_ids,
        max_iterations: wfStep.max_iterations,
      };

    case 'call_workflow': {
      const params: Record<string, ValueRef> = {};
      for (const [k, v] of Object.entries(wfStep.params)) {
        params[k] = exprToValueRef(v);
      }
      return {
        ...base,
        type: 'call_workflow',
        workflow_name: wfStep.workflow_name,
        params,
        capture_as: wfStep.capture_as,
      };
    }

    case 'llm_summarize':
      return {
        ...base,
        type: 'llm_summarize',
        input: exprToCaptureRef(wfStep.input, `step ${stepId} input`),
        prompt: wfStep.prompt,
        output_as: wfStep.output_as,
      };
  }
}

// ---------------------------------------------------------------------------
// Output bindings
// ---------------------------------------------------------------------------

const OUTPUT_EXPR = /^\{\{\s*(.+?)\s*\}\}$/;

function parseOutputBinding(
  name: string,
  fromExpr: string,
  retention: 'transient' | 'persisted',
): OutputBinding {
  // Strip surrounding {{ }} if present; the content is the JSONata expression
  const match = OUTPUT_EXPR.exec(fromExpr);
  const expression = match ? match[1]! : fromExpr;
  return { name, expression, retention };
}

// ---------------------------------------------------------------------------
// Main translator
// ---------------------------------------------------------------------------

/**
 * Translates a `WorkflowFile` and resolved params into a `TranslatedWorkflow`.
 *
 * This is a pure function — no I/O.
 *
 * @example
 * const result = translate(workflow, { month: '2026-04' });
 * const { plan, locatorTable, profileSpec } = result;
 */
export function translate(
  workflow: WorkflowFile,
  _params: Readonly<Record<string, unknown>>,
): TranslatedWorkflow {
  // Step 1: Assign step IDs and detect duplicates
  const seenIds = new Set<string>();
  const steps: Step[] = [];

  for (let i = 0; i < workflow.steps.length; i++) {
    const wfStep = workflow.steps[i]!;
    const stepId = wfStep.id ?? `s${i + 1}`;

    if (seenIds.has(stepId)) {
      throw new WorkflowTranslationError(
        'DUPLICATE_STEP_ID',
        `Duplicate step id "${stepId}" in workflow "${workflow.name}". ` +
          `Each step must have a unique id.`,
      );
    }
    seenIds.add(stepId);

    steps.push(translateStep(wfStep, stepId));
  }

  // Step 2: Build output bindings
  const outputBindings: OutputBinding[] = workflow.outputs.map((out) =>
    parseOutputBinding(out.name, out.from, 'persisted'),
  );

  // Step 3: Compute ProfileSpec
  const profileSpec = cookieModeToProfileSpec(workflow.cookies, workflow.name);

  // Step 4: Collect declared secret keys
  const declaredSecretKeys = [...workflow.secrets];

  // Step 5: Build locator table
  const locatorTable = buildLocatorTable(workflow._locators);

  // Step 6: Assemble the Plan
  const plan: Plan = {
    task_id: generateUlid(),
    plan_id: generateUlid(),
    schema_version: SCHEMA_VERSION,
    default_scope: workflow.security_class,
    steps,
    outputs: [], // Plan.outputs use CaptureRef; workflow outputs use JSONata — handled separately
  };

  // Step 7: Semantic validation (belt-and-suspenders)
  const validationResult = validateSemantics(plan);
  if (!validationResult.isOk) {
    const errors = validationResult.error;
    const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new WorkflowTranslationError(
      'SEMANTIC_VALIDATION_FAILED',
      `Workflow "${workflow.name}" failed semantic validation after translation:\n${messages}\n` +
        `This may indicate the workflow was modified between save and run. ` +
        `Run "yantra lint ${workflow.name}" to diagnose.`,
    );
  }

  return {
    plan,
    locatorTable,
    profileSpec,
    outputBindings,
    declaredSecretKeys,
  };
}

// ---------------------------------------------------------------------------
// ULID generation (Crockford base32)
// ---------------------------------------------------------------------------

/** Crockford base32 encoding alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generates a 26-character ULID compatible with the protocol ULID_PATTERN.
 *
 * Format: 10 timestamp chars + 16 random chars, Crockford base32 alphabet.
 */
function generateUlid(): string {
  // 48-bit timestamp (ms since epoch)
  let ts = Date.now();
  const tsChars: string[] = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    tsChars[i] = CROCKFORD[ts & 0x1f]!;
    ts = Math.floor(ts / 32);
  }

  // 80-bit random
  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  const randChars: string[] = new Array<string>(16);
  let bitBuf = 0;
  let bitsLeft = 0;
  let byteIdx = 0;
  for (let i = 0; i < 16; i++) {
    while (bitsLeft < 5) {
      bitBuf = (bitBuf << 8) | randBytes[byteIdx++]!;
      bitsLeft += 8;
    }
    bitsLeft -= 5;
    randChars[i] = CROCKFORD[(bitBuf >> bitsLeft) & 0x1f]!;
  }

  return tsChars.join('') + randChars.join('');
}
