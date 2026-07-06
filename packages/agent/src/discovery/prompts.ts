/**
 * Discovery proposer system prompt (FEAT-020 TASK-002).
 *
 * The prompt text lives here, agent-side, next to the other prompt templates
 * (`synthesis/prompt.ts`, `research/prompt.ts`). It describes a deliberately
 * narrow tool-catalog subset — the standard protocol step verbs minus the
 * plan-level constructs (`branch`/`loop`/`call_workflow`/`llm_summarize`) that
 * make no sense inside a single 1–3-step ad-hoc cycle — plus the
 * semantic-locator-only shape the model must emit. `packages/protocol`'s
 * `validateDiscoveryProposal` is the actual enforcement point (this prompt
 * text alone is not a security boundary); the rules stated here exist so a
 * well-behaved model rarely needs a re-prompt.
 *
 * Consent and honesty rules are stated explicitly per plan §6: the model does
 * not need to (and cannot) opt out of the confirmation gateway — every
 * mutating verb is force-flagged downstream regardless of what it emits — and
 * it must never claim to route around an ethics/bot block.
 */

/** One step verb usable inside a discovery proposal, with its JSON shape. */
const STEP_CATALOG = [
  {
    verb: 'navigate',
    shape: `{ "id": "s1", "type": "navigate", "url": { "kind": "literal", "value": "<https url>" } }`,
  },
  {
    verb: 'click',
    shape: `{ "id": "s1", "type": "click", "locator": <intent locator>, "modifiers": null }`,
  },
  {
    verb: 'fill',
    shape:
      `{ "id": "s1", "type": "fill", "locator": <intent locator>, ` +
      `"value": { "kind": "literal", "value": "<text>" }, "submit": false }`,
  },
  {
    verb: 'extract',
    shape:
      `{ "id": "s1", "type": "extract", "locator": <intent locator>, ` +
      `"extraction_schema": { "type": "primitive", "kind": "string" }, "capture_as": "result" }`,
  },
  {
    verb: 'wait_for',
    shape: `{ "id": "s1", "type": "wait_for", "locator": <intent locator>, "state": "visible", "timeout_ms": null }`,
  },
  {
    verb: 'assert',
    shape: `{ "id": "s1", "type": "assert", "locator": <intent locator>, "condition": { "kind": "visible" } }`,
  },
] as const;

const LOCATOR_SHAPE = [
  '<intent locator> is ALWAYS this exact shape — never css, xpath, or any other kind:',
  '{ "kind": "intent", "role": "<aria role>", "name_match": <name match or null>, "near": null }',
  '',
  'Valid roles: button, link, textbox, table, heading, region, dialog, listitem, cell,',
  'checkbox, radio, combobox, option, tab, tabpanel, menuitem, row, grid.',
  '',
  '<name match or null> is one of:',
  '  { "kind": "exact", "value": "<exact accessible name>" }',
  '  { "kind": "regex", "pattern": "<pattern>", "flags": "i" }',
  '  null (matches any element of that role)',
  '',
  'Only reference roles/names that appear in the INTERACTABLES list of the latest',
  'observation. Never invent a selector, id, or CSS class — you cannot see the DOM,',
  'only the sanitized observation you are given.',
].join('\n');

const SYSTEM_PROMPT = [
  "You are Yantra's discovery agent. You work the LIVE web in real time toward a",
  'goal you have no saved workflow for. Each turn you see the goal, a trimmed',
  'history of what happened so far, and the latest page observation — you propose',
  'the SMALLEST next step(s) (1-3) that move toward the goal, or declare done.',
  '',
  'Hard rules:',
  '- Propose at most 3 steps per turn. Prefer 1 when possible.',
  '- Every mutating step (navigate, click, fill) is automatically paused for human',
  '  consent before it executes — you do not need to ask for this yourself, and you',
  '  cannot disable it.',
  '- You have NO access to secrets, passwords, or stored credentials. Never propose',
  '  filling a credential field. If the goal requires a login you cannot complete,',
  '  stop and report that in `done` — do not guess a password or skip the field.',
  '- If a page shows a bot-detection wall, CAPTCHA, paywall, or is otherwise',
  '  blocked, do NOT try to evade it. Report the block honestly in `done.summary_md`',
  '  (goal_met: false) or propose a different, legitimate path — never fingerprint-',
  '  cloak or escalate.',
  '- `citations_hint` may ONLY list URLs of pages you have actually visited (present',
  '  in a prior observation). Never cite a page you have not seen.',
  '- Set `done` (non-null) only when the goal is met, unreachable, or you are stuck.',
  '  `done.goal_met` distinguishes success from an honest stop.',
  '- Output MUST be a single JSON object matching the shape below and nothing else —',
  '  no prose, no code fences.',
  '',
  '## Available step verbs',
  '',
  ...STEP_CATALOG.flatMap((entry) => [`### ${entry.verb}`, entry.shape, '']),
  '## Locators',
  '',
  LOCATOR_SHAPE,
  '',
  '## Response shape',
  '',
  '{',
  '  "rationale": string (<=1000 chars, your reasoning — audited, never executed),',
  '  "steps": [ <1-3 steps from the catalog above> ],',
  '  "done": null | { "goal_met": boolean, "summary_md": string, "citations_hint": string[] }',
  '}',
  '',
  'When `done` is non-null, `steps` may be an empty-effect turn (still requires >=1',
  'entry per schema — repeat the last observational step, e.g. a no-op `assert`, if',
  'you have nothing left to do) — prefer setting `done` only once no further step is',
  'needed, i.e. after the observation already confirms the goal.',
].join('\n');

/** One prior cycle, trimmed for the prompt (full or one-line, per session-state). */
export interface DiscoveryPromptCycleSummary {
  /** Full detail for the most recent cycles. */
  readonly kind: 'full';
  readonly index: number;
  readonly rationale: string;
  readonly stepsDescription: string;
  readonly observationDigest: string | null;
  readonly interactablesDescription: string;
  readonly stepOutcome: string;
}

/** A collapsed one-line summary for older cycles (context bound). */
export interface DiscoveryPromptCycleOneLine {
  readonly kind: 'one_line';
  readonly index: number;
  readonly summary: string;
}

export type DiscoveryPromptCycle = DiscoveryPromptCycleSummary | DiscoveryPromptCycleOneLine;

/** Inputs the discovery user-prompt builder receives. */
export interface DiscoveryPromptInput {
  readonly goal: string;
  readonly hostAllowlist: readonly string[];
  /** Trimmed cycle history — see `session-state.ts` for the trimming policy. */
  readonly history: readonly DiscoveryPromptCycle[];
}

/** Structural shape the agent-side `propose()` builds and consumes. */
export interface DiscoveryPromptTemplate {
  readonly system: string;
  buildUser(input: DiscoveryPromptInput): string;
  buildReprompt(issues: readonly string[]): string;
}

export const DISCOVERY_PROMPT: DiscoveryPromptTemplate = {
  system: SYSTEM_PROMPT,

  buildUser(input: DiscoveryPromptInput): string {
    const historyLines =
      input.history.length > 0
        ? renderHistory(input.history)
        : '(no cycles yet — this is the first turn)';

    return [
      `GOAL: ${input.goal}`,
      '',
      `ALLOWED HOSTS: ${input.hostAllowlist.join(', ')}`,
      '(navigating outside this list will be blocked — request a different path instead)',
      '',
      '=== HISTORY ===',
      historyLines,
      '',
      'Propose the next step(s), or set `done` if the goal is met/unreachable. JSON only.',
    ].join('\n');
  },

  buildReprompt(issues: readonly string[]): string {
    const lines = issues.map((issue) => `  - ${issue}`);
    return [
      'Your previous JSON failed validation. Fix exactly these issues and re-emit the',
      'COMPLETE corrected JSON object (no prose, no code fences):',
      '',
      ...lines,
    ].join('\n');
  },
};

function renderHistory(history: readonly DiscoveryPromptCycle[]): string {
  return history
    .map((cycle) => {
      if (cycle.kind === 'one_line') {
        return `[cycle ${cycle.index}] ${cycle.summary}`;
      }
      return [
        `[cycle ${cycle.index}] rationale: ${cycle.rationale}`,
        `  steps: ${cycle.stepsDescription}`,
        `  outcome: ${cycle.stepOutcome}`,
        cycle.observationDigest !== null
          ? `  page: ${cycle.observationDigest}`
          : '  page: (not reached)',
        `  interactables: ${cycle.interactablesDescription}`,
      ].join('\n');
    })
    .join('\n\n');
}
