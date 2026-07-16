import type { AgentBudgetConfig } from './orchestrator.js';

/** Commands that can start an agentic Yantra session. */
export type AgenticCommand = 'ask' | 'research' | 'do';

/** Registered capability names; profiles are intentionally least-privilege. */
export type YantraToolName =
  | 'web_search'
  | 'web_fetch'
  | 'script_run'
  | 'result_publish'
  | 'workflow_run'
  | 'browser_navigate'
  | 'browser_observe'
  | 'browser_click'
  | 'browser_fill'
  | 'browser_extract';

/** The portion of `workflow_run` permitted by a command profile. */
export type WorkflowToolMode = 'none' | 'list' | 'run';

/** Presentation family selected by the shared `result_publish` contract. */
export type BriefKind = 'answer' | 'research' | 'task';

/** Immutable preset governing one command's agentic session. */
export interface CommandTaskProfile {
  readonly command: AgenticCommand;
  readonly toolNames: readonly YantraToolName[];
  readonly workflowToolMode: WorkflowToolMode;
  readonly budgets: Partial<AgentBudgetConfig>;
  /** Appended only to the per-run user prompt, never the system prompt. */
  readonly promptAddendum: string;
  readonly briefKind: BriefKind;
}

const READ_TOOLS = ['web_search', 'web_fetch', 'script_run', 'result_publish'] as const;
const BROWSE_TOOLS = ['browser_navigate', 'browser_observe', 'browser_extract'] as const;
const ALL_TOOLS = [
  ...READ_TOOLS,
  'workflow_run',
  ...BROWSE_TOOLS,
  'browser_click',
  'browser_fill',
] as const;

/** Stable default profiles. Configured copies are obtained with `resolveCommandTaskProfile`. */
export const COMMAND_TASK_PROFILES: Readonly<Record<AgenticCommand, CommandTaskProfile>> = {
  ask: {
    command: 'ask',
    toolNames: [...READ_TOOLS, 'workflow_run'],
    workflowToolMode: 'list',
    budgets: { wallClockMs: 120_000, totalToolCalls: 20, perToolCalls: 10 },
    promptAddendum:
      'Answer the question directly, verify claims with cited sources, and publish an answer Brief.',
    briefKind: 'answer',
  },
  research: {
    command: 'research',
    toolNames: [...READ_TOOLS, 'workflow_run'],
    workflowToolMode: 'run',
    budgets: { wallClockMs: 300_000, totalToolCalls: 45, perToolCalls: 20 },
    promptAddendum:
      'Research broadly before publishing: use independent sources, cover material gaps, cite the evidence for every substantive conclusion, and publish a research Brief.',
    briefKind: 'research',
  },
  do: {
    command: 'do',
    toolNames: ALL_TOOLS,
    workflowToolMode: 'run',
    budgets: {},
    promptAddendum: 'Complete the requested task safely, verify the outcome, and publish a task Brief.',
    briefKind: 'task',
  },
};

/**
 * Returns a configured profile. Environment keys are the CLI configuration
 * surface until persistent agent-budget config is introduced:
 * `YANTRA_AGENT_<COMMAND>_{BUDGET_MS,MAX_TOOL_CALLS,MAX_CALLS_PER_TOOL}`.
 * Research browsing is explicitly opt-in via `YANTRA_AGENT_RESEARCH_BROWSE=1`.
 */
export function resolveCommandTaskProfile(
  command: AgenticCommand,
  env: NodeJS.ProcessEnv = process.env,
): CommandTaskProfile {
  const base = COMMAND_TASK_PROFILES[command];
  const prefix = `YANTRA_AGENT_${command.toUpperCase()}_`;
  const budgets: Partial<AgentBudgetConfig> = {
    ...base.budgets,
    ...positive(env[`${prefix}BUDGET_MS`], 'wallClockMs'),
    ...positive(env[`${prefix}MAX_TOOL_CALLS`], 'totalToolCalls'),
    ...positive(env[`${prefix}MAX_CALLS_PER_TOOL`], 'perToolCalls'),
  };
  const browseEnabled =
    command === 'research' && (env.YANTRA_AGENT_RESEARCH_BROWSE === '1' || env.YANTRA_AGENT_RESEARCH_BROWSE === 'true');

  return {
    ...base,
    budgets,
    toolNames: browseEnabled ? [...base.toolNames, ...BROWSE_TOOLS] : [...base.toolNames],
  };
}

function positive(raw: string | undefined, key: keyof AgentBudgetConfig): Partial<AgentBudgetConfig> {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? { [key]: value } : {};
}
