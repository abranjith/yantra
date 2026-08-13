import type { TemplateManifest } from '@yantra/protocol';

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
  | 'browser_fill_element'
  | 'browser_fill_form'
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
  /** Appended only to the per-run user prompt, never the system prompt. */
  readonly promptAddendum: string;
  readonly briefKind: BriefKind;
}

const READ_TOOLS = ['web_search', 'web_fetch', 'script_run', 'result_publish'] as const;
const BROWSE_TOOLS = ['browser_navigate', 'browser_observe', 'browser_extract'] as const;
// Browser fill tools mutate the page, so they belong here beside
// `browser_click` and deliberately NOT in BROWSE_TOOLS — that set
// is `research`'s opt-in *read-only* browse mode.
const ALL_TOOLS = [
  ...READ_TOOLS,
  'workflow_run',
  ...BROWSE_TOOLS,
  'browser_click',
  'browser_fill_element',
  'browser_fill_form',
] as const;

/** Stable default profiles. Configured copies are obtained with `resolveCommandTaskProfile`. */
export const COMMAND_TASK_PROFILES: Readonly<Record<AgenticCommand, CommandTaskProfile>> = {
  ask: {
    command: 'ask',
    toolNames: [...READ_TOOLS, 'workflow_run'],
    workflowToolMode: 'list',
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
    promptAddendum:
      'Complete the requested task safely, verify the outcome, and finish by calling ' +
      'result_publish with {"brief": {"title": "...", "overview": "..."}} to publish a task ' +
      'Brief. When a form needs more than one field set, fill it with a single ' +
      'browser_fill_form listing every field — one call for the whole search form (destination, ' +
      'dates, travellers), not one call per field. browser_fill_element is for a form with one ' +
      'field to set, or for a stored secret. Filling fields one at a time is what makes a search ' +
      'form fall apart: each call re-reads a page the previous call just re-rendered, so the ' +
      'later fields resolve against controls that have moved or been replaced. ' +
      'Both tools handle text, stored secrets, dates, ranges, suggestions, dropdowns, ' +
      'radio groups, and toggles, and each owns the whole widget lifecycle — opening a calendar ' +
      'or dropdown, choosing, and closing it again. Set a date range in one call: send both ends ' +
      'together in one browser_fill_form, or one field with the value "YYYY-MM-DD..YYYY-MM-DD". ' +
      'A check-in/check-out picker commits the pair as a unit, so filling one end by itself is ' +
      'discarded. Use browser_click only to ' +
      'activate something or submit a completed form, never to operate a field widget by hand: ' +
      'opening a picker yourself and clicking day cells is slower and loses the verification the ' +
      'fill tools perform. They also recover from the page replacing a control mid-fill, so a ' +
      'failure means recovery was already tried — read its suggestion and follow that rather ' +
      'than repeating the identical call. The fill tools ' +
      'verify their own result and return the committed value, so a success needs no confirming ' +
      'browser_observe. Action tools return a fresh observation, ' +
      'so do not chain browser_observe after every action. Many sites open their results in a ' +
      'new tab. When the site opens that tab on its own domain the run follows it for you and ' +
      'the result says switched_to_new_tab — you are already on the results page, so read it ' +
      'rather than navigating anywhere. Otherwise the tab is closed and its address returned as ' +
      'popup_intercepted, which still means the search worked: pass that URL to browser_navigate ' +
      'instead of retrying the click. Disabled elements are marked ' +
      'disabled: true; choose a different element. If a site widget still resists after a bounded ' +
      'number of attempts, publish what you verified and state the gap precisely. Do not switch ' +
      'to web_search for data the goal asked you to read from a specific site.',
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
 * Returns a configured profile. Budgets are resolved once by the shared CLI
 * agent-option surface; profiles retain only capabilities and prompt behavior.
 * Research browsing is explicitly opt-in via `YANTRA_AGENT_RESEARCH_BROWSE=1`.
 */
export function resolveCommandTaskProfile(
  command: AgenticCommand,
  env: NodeJS.ProcessEnv = process.env,
): CommandTaskProfile {
  const base = COMMAND_TASK_PROFILES[command];
  const browseEnabled =
    command === 'research' &&
    (env.YANTRA_AGENT_RESEARCH_BROWSE === '1' || env.YANTRA_AGENT_RESEARCH_BROWSE === 'true');

  return {
    ...base,
    toolNames: browseEnabled ? [...base.toolNames, ...BROWSE_TOOLS] : [...base.toolNames],
  };
}
