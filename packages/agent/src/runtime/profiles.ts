import type { TemplateManifest } from '@yantra/protocol';

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
    budgets: { totalToolCalls: 12, perToolCalls: 6 },
    promptAddendum:
      'Answer the question directly from the fetched evidence, then finish by calling ' +
      'result_publish with {"brief": {"title": "...", "overview": "..."}} to publish an answer ' +
      'Brief — the pages you fetched are attached as sources automatically, so never re-search ' +
      'for or re-type URLs. Each web_search returns the top sources already fetched with their ' +
      'page content; read that evidence rather than re-searching, and use web_fetch only to ' +
      'follow a specific link.',
    briefKind: 'answer',
  },
  research: {
    command: 'research',
    toolNames: [...READ_TOOLS, 'workflow_run'],
    workflowToolMode: 'run',
    budgets: { totalToolCalls: 30, perToolCalls: 12 },
    promptAddendum:
      'Research broadly before publishing: use independent sources and cover material gaps, ' +
      'then finish by calling result_publish with {"brief": {"title": "...", "overview": "...", ' +
      '"key_findings": ["..."]}} to publish a research Brief — every page you fetched is ' +
      'attached as a source automatically, so never re-search for or re-type URLs. Each ' +
      'web_search returns fetched source content, not just links — follow specific leads with ' +
      'web_fetch.',
    briefKind: 'research',
  },
  do: {
    command: 'do',
    toolNames: ALL_TOOLS,
    workflowToolMode: 'run',
    budgets: {},
    promptAddendum:
      'Complete the requested task safely, verify the outcome, and finish by calling ' +
      'result_publish with {"brief": {"title": "...", "overview": "..."}} to publish a task Brief.',
    briefKind: 'task',
  },
};

/**
 * Resolve the per-run completion addendum for the active output contract.
 *
 * The stored profile strings remain the compatibility-locked Brief prompts.
 * Template mode replaces only the tool mechanics with manifest-derived slot
 * names; the authoritative system prompt remains output-shape agnostic.
 */
export function promptAddendumFor(
  profile: CommandTaskProfile,
  manifest: TemplateManifest | null,
): string {
  if (manifest === null) return profile.promptAddendum;
  const slots = manifest.slots
    .filter((slot) => slot.kind !== 'sources')
    .map((slot) => `"${slot.key}"`)
    .join(', ');
  const researchDirection =
    profile.command === 'ask'
      ? 'Answer the question directly from the fetched evidence.'
      : profile.command === 'research'
        ? 'Research broadly, use independent sources, and cover material gaps before publishing.'
        : 'Complete the requested task safely and verify the outcome.';
  return (
    `${researchDirection} Finish by calling result_publish with a report object containing ` +
    `these required template slots: ${slots}. Yantra renders the surrounding Markdown document ` +
    'and attaches every page you fetched as sources automatically; supply slot values only.'
  );
}

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
    command === 'research' &&
    (env.YANTRA_AGENT_RESEARCH_BROWSE === '1' || env.YANTRA_AGENT_RESEARCH_BROWSE === 'true');

  return {
    ...base,
    budgets,
    toolNames: browseEnabled ? [...base.toolNames, ...BROWSE_TOOLS] : [...base.toolNames],
  };
}

function positive(
  raw: string | undefined,
  key: keyof AgentBudgetConfig,
): Partial<AgentBudgetConfig> {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? { [key]: value } : {};
}
