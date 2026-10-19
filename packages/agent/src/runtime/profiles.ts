import type { TemplateManifest } from '@yantra/protocol';

import { FILL_FORM_MAX_FIELDS } from '../adapters/pi/tools/fill-limits.js';

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
  | 'browser_extract'
  | 'browser_screenshot'
  | 'browser_capture'
  | 'task_contract';

/** The portion of `workflow_run` permitted by a command profile. */
export type WorkflowToolMode = 'none' | 'list' | 'run';

/** Presentation family selected by the shared `result_publish` contract. */
export type BriefKind = 'answer' | 'research' | 'task';

/** Immutable preset governing one command's agentic session. */
export interface CommandTaskProfile {
  readonly command: AgenticCommand;
  readonly progress: 'enforce' | 'observe';
  readonly toolNames: readonly YantraToolName[];
  readonly workflowToolMode: WorkflowToolMode;
  /** Appended only to the per-run user prompt, never the system prompt. */
  readonly promptAddendum: string;
  readonly briefKind: BriefKind;
}

const READ_TOOLS = ['web_search', 'web_fetch', 'script_run', 'result_publish'] as const;

// Source fidelity (FEAT-052): a source the goal names is where the answer
// comes from. Shared verbatim by every addendum that carries it.
const REQUIRED_SOURCE =
  'When the goal names a site or source, that source is required: read the answer from it, ' +
  'and present any other source only as a clearly labeled alternative, never merged into the ' +
  'answer.';
const DECLARE_CONTRACT = 'Call task_contract in the same turn as your first search or fetch.';
// FEAT-054: the requirements the engine checks live in the contract, not in
// notes. Shared by the `do` addendum only; research cannot declare actions.
const DECLARE_ACTIONS =
  'When the goal changes or captures a page, declare deliverable "actions": put "every field" ' +
  'or the fields to fill in fill, a requested screenshot in artifacts, and "do not submit" in ' +
  'effects, never in notes, which nothing checks. The result is judged item by item from what ' +
  'the tools recorded, so publish even when an item is unmet and say why in fulfillment.unmet.';
// FEAT-058: a requested screenshot is a saved deliverable, never a view the
// model receives. `browser_capture` is registered whenever `do` has a browser.
const CAPTURE_DELIVERABLE =
  'When the task asks for a screenshot, declare it in artifacts and call browser_capture after ' +
  'your last page action; the image is saved for the user and you are told its path, not shown it.';
const PUBLISH_GUIDANCE =
  'Finish with result_publish. Cite evidence by the source_id a result showed (S3) or a record ' +
  'id (S3#r5): findings as {"text": "...", "sources": ["S3"]}, and prose as [S3]. When the ' +
  'goal asks for items with fields, publish a table {"columns": [...], "rows": [[...]], ' +
  '"row_sources": [["S3#r1"]]} with one row per item and one column per field. Report each ' +
  'condition the goal set in constraints with status verified, unverified, or violated, and ' +
  'list anything you could not deliver in fulfillment.unmet with the reason.';

/**
 * The research addendum. `browse` adds the one sentence naming the live
 * browser tools, so a run without them is never told about them.
 */
function researchAddendum(browse: boolean): string {
  return (
    `${REQUIRED_SOURCE} Otherwise use independent sources and cover material gaps. ` +
    `${DECLARE_CONTRACT} To find a page, use web_search (limit: 0 lists URLs without reading ` +
    'them). When a page lists items, follow its records[] and links[] to the pages you need ' +
    '(pagination, filters, details) rather than searching for them. ' +
    (browse
      ? 'Use browser_navigate and browser_extract for a page that needs a live browser. '
      : '') +
    PUBLISH_GUIDANCE +
    ' Each web_search returns fetched source content, not just links — follow specific leads with web_fetch.'
  );
}
const BROWSE_TOOLS = ['browser_navigate', 'browser_observe', 'browser_extract'] as const;
// Browser fill tools mutate the page, so they belong here beside
// `browser_click` and deliberately NOT in BROWSE_TOOLS — that set
// is `research`'s *read-only* browse mode (on unless the user turns it off).
// Deliverable capture (FEAT-058 S2) is registered only beside one of these.
export const INTERACT_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_fill_element',
  'browser_fill_form',
]);
const ALL_TOOLS = [
  ...READ_TOOLS,
  'workflow_run',
  'task_contract',
  ...BROWSE_TOOLS,
  'browser_click',
  'browser_fill_element',
  'browser_fill_form',
] as const;

/** Stable default profiles. Configured copies are obtained with `resolveCommandTaskProfile`. */
export const COMMAND_TASK_PROFILES: Readonly<Record<AgenticCommand, CommandTaskProfile>> = {
  ask: {
    command: 'ask',
    progress: 'observe',
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
    progress: 'observe',
    toolNames: [...READ_TOOLS, 'workflow_run', 'task_contract'],
    workflowToolMode: 'run',
    // The stable default is the no-browse catalog; `resolveCommandTaskProfile`
    // swaps in the browse addendum together with the browse tools.
    promptAddendum: researchAddendum(false),
    briefKind: 'research',
  },
  do: {
    command: 'do',
    progress: 'enforce',
    toolNames: ALL_TOOLS,
    workflowToolMode: 'run',
    promptAddendum:
      `If Yantra sends a progress check, follow its Next step or publish what you have; it is sent at most once. Complete the requested task safely and verify the outcome. ${PUBLISH_GUIDANCE} ` +
      `${REQUIRED_SOURCE} ${DECLARE_CONTRACT} ${DECLARE_ACTIONS} ${CAPTURE_DELIVERABLE} ` +
      `When a form needs more than one field set, use browser_fill_form: up to ${FILL_FORM_MAX_FIELDS} fields per call, ` +
      'in page order, never one call per field. A longer form takes several calls; after each one, read its ' +
      'progress (how many eligible fields remain, and the next ones by ref) and send those, rather than observing again. ' +
      'browser_fill_element is for a form with one field to set, or for a stored secret. ' +
      'Filling fields one at a time makes a re-rendering form fall apart: each call re-reads a page the previous call just changed. ' +
      'Both tools handle text, stored secrets, dates, ranges, suggestions, dropdowns, ' +
      'radio groups, and toggles, and each owns the whole widget lifecycle — opening a calendar ' +
      'or dropdown, choosing, and closing it again. Set a date range in one call: send both ends ' +
      'together in one browser_fill_form, or one field with the value "YYYY-MM-DD..YYYY-MM-DD". ' +
      'A range picker that commits both ends together discards one end filled by itself. Use browser_click only to ' +
      'activate something or submit a completed form, never to operate a field widget by hand: ' +
      'opening a picker yourself and clicking day cells is slower and loses the verification the ' +
      'fill tools perform. ' +
      'When you report what you did, cite the action ID from the tool result ([A3]); cite pages ([S1]) only for what a page said. ' +
      // How to read what these tools return. Every clause below replaces a
      // guess the model would otherwise have to make about whether its own
      // action worked — which is the failure this guidance exists to prevent.
      'An applied field that landed exactly as sent lists only field, ref, and resolution; every other field carries full detail. ' +
      'READ THE RESULT BEFORE ACTING AGAIN. A successful fill reports "requested" (what you ' +
      'sent), "committed" (what the control now holds), and "resolution" (how the two relate). ' +
      'A "committed" that differs from what you sent is normal and is the widget resolving your ' +
      'value to something it actually offers — a field asked for a short code ' +
      'commits the full name the widget offers — so accept it and move on. Never re-fill a field to force your ' +
      'original wording back into it. An "editee" in a result means the page routed the edit to ' +
      'a different control and the value did land there; the field you named staying empty is ' +
      'not a failure and is not something to fix. A failure carries "observed" (what the control ' +
      'holds right ' +
      'now, which is often not empty), "attempted" (an ordered list of recovery verdicts, such as ' +
      'several ways of entering the text or several widget drivers), and sometimes "offered" ' +
      '(what the widget will actually accept). Each entry in "attempted" carries a "verdict": ' +
      '"succeeded" and "failed" name steps the tool already performed, so never repeat one of ' +
      'those — it has already been done. A "skipped" entry names a step the tool did NOT take ' +
      'and says why in "unmet"; it is information, not a prohibition. ' +
      'When "offered" is present, re-issue the same call with one of those ' +
      'strings exactly as written; that is the fastest path through an ambiguous suggestion ' +
      'list. ' +
      // How to read a batch. Each clause replaces a wrong inference the model
      // would otherwise draw from a result that is neither a clean success nor
      // a clean failure.
      'A browser_fill_form result reports three sets: "applied" (fields that landed), "failed" ' +
      '(fields attempted that did not take), and "skipped" (fields not attempted). Every field is ' +
      'accounted for exactly once. An entry can account for more than the field it ' +
      'names: "covers" lists all fields that entry stands for in any of the three sets. A field ' +
      'named in another entry\'s "covers" is already accounted for, so do not re-send it as if it ' +
      'were missing. When a covering entry fails, resolve all of its fields together. A batch with ' +
      'both applied and failed fields is progress, not a retry trigger — the applied fields are ' +
      'set, so re-sending them undoes work and wastes a turn. Send only the failed fields again, ' +
      'and only after reading why each one failed. A "skipped" field names the field blocking it ' +
      'in "blocked_by": it shares a widget with a field that failed, so resolve that field first ' +
      'and then send the skipped one. The fill tools ' +
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
 * What a catalog lets the model do with a live browser. `read` is navigate,
 * observe, and extract; `interact` adds any tool that clicks or fills.
 */
export type BrowserCapability = 'none' | 'read' | 'interact';

/**
 * Derives a catalog's browser capability from its tool names alone, so the
 * per-run prompt can never claim a capability the session was not given.
 */
export function browserCapabilityOf(toolNames: readonly string[]): BrowserCapability {
  if (toolNames.some((name) => INTERACT_TOOLS.has(name))) return 'interact';
  if (toolNames.some((name) => name.startsWith('browser_'))) return 'read';
  return 'none';
}

/** Per-run choices a caller makes when resolving a command profile. */
export interface CommandTaskProfileOptions {
  /**
   * Whether `research` gets the read-only browser tools. Read only for
   * `research`; `ask` never browses and `do` always does. Defaults to `true`.
   */
  readonly browse?: boolean;
}

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
        ? `${REQUIRED_SOURCE} Otherwise use independent sources and cover material gaps before publishing.`
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
 *
 * `research` browses read-only (navigate, observe, extract — never click or
 * fill) unless `options.browse` is `false`. The CLI resolves that value from
 * `--no-browse` and the stored `agent.research_browse` preference; nothing in
 * the environment can change a catalog.
 */
export function resolveCommandTaskProfile(
  command: AgenticCommand,
  options: CommandTaskProfileOptions = {},
): CommandTaskProfile {
  const base = COMMAND_TASK_PROFILES[command];
  const browseEnabled = command === 'research' && options.browse !== false;

  return {
    ...base,
    toolNames: browseEnabled ? [...base.toolNames, ...BROWSE_TOOLS] : [...base.toolNames],
    ...(browseEnabled ? { promptAddendum: researchAddendum(true) } : {}),
  };
}
