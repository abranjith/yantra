/** A hand-verified option the CLI registers but does not act on. */
export interface KnownDeadOption {
  readonly command: string;
  readonly option: string;
  readonly since: string;
  /**
   * `unread`: no consumer exists. `refused`: the handler reads the option only
   * to reject it; `evidence` is the refusal text, which must still be present.
   */
  readonly kind: 'unread' | 'refused';
  readonly evidence: string;
  readonly todo: string;
}

export const DEAD_OPTION_TODO =
  'TODO.md: wire or remove dead run/resume/confirm controls (FEAT-062)';

const SINCE = '2026-11-03';
const RUN_BUDGETS = 'run.ts passes `budgets: {}` to the synthesis runtime';
const RESUME_BUDGETS = 'resume.ts resolves the agent but never reads `.budgets`';
const BUDGET_FLAGS = [
  '--max-duration',
  '--max-tokens',
  '--tool-timeout',
  '--tool-retries',
  '--confirm-timeout',
] as const;

export const KNOWN_DEAD_OPTIONS: readonly KnownDeadOption[] = [
  ...BUDGET_FLAGS.map((option) => ({
    command: 'run',
    option,
    since: SINCE,
    kind: 'unread' as const,
    evidence: RUN_BUDGETS,
    todo: DEAD_OPTION_TODO,
  })),
  {
    command: 'run',
    option: '--no-screenshots',
    since: SINCE,
    kind: 'unread',
    evidence: 'run.ts never reads `screenshots`; replay captures no vision screenshots',
    todo: DEAD_OPTION_TODO,
  },
  {
    command: 'run',
    option: '--template',
    since: SINCE,
    kind: 'refused',
    evidence: 'templates are not yet supported on run',
    todo: DEAD_OPTION_TODO,
  },
  ...BUDGET_FLAGS.map((option) => ({
    command: 'resume',
    option,
    since: SINCE,
    kind: 'unread' as const,
    evidence: RESUME_BUDGETS,
    todo: DEAD_OPTION_TODO,
  })),
  {
    command: 'resume',
    option: '--no-screenshots',
    since: SINCE,
    kind: 'unread',
    evidence: 'resume.ts never reads `screenshots`',
    todo: DEAD_OPTION_TODO,
  },
  {
    command: 'confirm',
    option: '--debug',
    since: SINCE,
    kind: 'unread',
    evidence: 'confirm.ts declares `debug` in ConfirmOptions and never reads it',
    todo: DEAD_OPTION_TODO,
  },
];
