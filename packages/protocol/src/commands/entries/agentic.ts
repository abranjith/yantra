/** Web tasks that may open a provider session: `ask`, `research`, `do`. */

import type { InputKind, OptionSpecInput, Relation } from '../schema.js';

import { argument, exit, leaf, option, PARSE_ERRORS } from './builders.js';

/** `--browser-path` names one executable, which only `--browser system` can mean. */
export const BROWSER_PATH_RELATION: Relation = {
  kind: 'conflicts',
  option: '--browser-path',
  with: ['--browser'],
  note: 'rejected unless --browser is system or absent (resolveBrowserSelectionOverride)',
};

/** Templates need the model; `--no-llm` with `--template` is a validation failure. */
const TEMPLATE_NEEDS_LLM: Relation = {
  kind: 'conflicts',
  option: '--template',
  with: ['--no-llm'],
  note: 'templates require LLM mode; drop --no-llm or drop --template',
};

/** Shared `--template` spelling (formerly `TEMPLATE_OPTION_DESCRIPTION`). */
export const TEMPLATE_OPTION_DESCRIPTION =
  'render the result with a saved name, tag, or Markdown template path';

const templateOption = (): OptionSpecInput =>
  option('--template <name|tag|path>', TEMPLATE_OPTION_DESCRIPTION, {
    input: { kind: 'template-ref' },
  });

const formatOption = (): OptionSpecInput =>
  option('--format <format>', 'output format sent to stdout', {
    default: 'terminal',
    input: { kind: 'enum', choices: ['terminal', 'md', 'html', 'json'], enforced_by: 'parser' },
  });

const DETAIL_CHOICES: InputKind = {
  kind: 'enum',
  choices: ['overview', 'standard', 'full'],
  enforced_by: 'parser',
};
const LENGTH_CHOICES: InputKind = {
  kind: 'enum',
  choices: ['short', 'medium', 'long'],
  enforced_by: 'parser',
};
const SEARCH_PROVIDERS: InputKind = {
  kind: 'enum',
  choices: ['auto', 'google', 'duckduckgo', 'brave', 'tavily'],
  enforced_by: 'parser',
};
const TERMINAL_ONLY = [{ option: '--format', equals: 'terminal' }] as const;
const DETERMINISTIC_ONLY = [{ mode: 'deterministic' }] as const;
const AGENT_GROUPS = [
  { group: 'agent-model' },
  { group: 'agent-budget' },
  { group: 'no-llm' },
  { group: 'screenshots' },
] as const;

const BRIEF_EXITS = [
  exit.ok('a Brief was published'),
  exit.validation(
    `${PARSE_ERRORS}, an invalid model, budget or browser selection, a template with --no-llm, or a malformed @{…} marker`,
  ),
  exit.execution('the run failed'),
] as const;

export const ask = leaf({
  id: 'ask',
  description: 'Answer a question from the web as a synthesized Brief.',
  registration: 'subcommand',
  arguments: [
    argument('query', { description: 'question to answer from web sources', required: true }),
  ],
  options: [
    ...AGENT_GROUPS,
    { group: 'browser-selection' },
    option('--json', 'shorthand for --format json', { default: false }),
    option('--detail <level>', 'terminal disclosure level (default: prefs.defaults.detail)', {
      input: DETAIL_CHOICES,
      precedence: [
        { source: 'flag' },
        { source: 'preference', key: 'defaults.detail' },
        { source: 'default', value: 'standard' },
      ],
      applicability: [...TERMINAL_ONLY],
    }),
    formatOption(),
    option('--length <length>', 'synthesis length budget (default: prefs.defaults.length)', {
      input: LENGTH_CHOICES,
      precedence: [
        { source: 'flag' },
        { source: 'preference', key: 'defaults.length' },
        { source: 'default', value: 'medium' },
      ],
    }),
    option('--open', 'open the generated brief.html in the default browser'),
    templateOption(),
    option('--no-cache', 'disable cache reads/writes'),
    option('--no-color', 'disable ANSI color output'),
    option('--max-sources <n>', 'maximum sources to fetch', {
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option(
      '--search-provider <provider>',
      'search provider (default: auto walks tavily -> brave -> duckduckgo); tavily/brave require API keys, google/duckduckgo scrape (google is opt-in)',
      {
        input: SEARCH_PROVIDERS,
        precedence: [
          { source: 'flag' },
          { source: 'preference', key: 'defaults.search_provider' },
          { source: 'default', value: 'auto', note: 'auto walks tavily -> brave -> duckduckgo' },
        ],
      },
    ),
    option('--limit <count>', 'number of sources to consider', {
      default: '3',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option('--fetch-timeout <ms>', 'per-fetch timeout in ms', {
      default: '30000',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option('--pipeline-timeout <duration>', 'deterministic pipeline timeout (for example 100s)', {
      default: '100s',
      input: { kind: 'duration' },
      applicability: [...DETERMINISTIC_ONLY],
    }),
  ],
  execution: { default: 'run' },
  effect: 'external',
  danger: { level: 'none' },
  relations: [BROWSER_PATH_RELATION, TEMPLATE_NEEDS_LLM],
  exit_codes: [...BRIEF_EXITS],
  json: { flag: '--json', shape: 'document', schema: 'Brief' },
});

export const research = leaf({
  id: 'research',
  description: 'Deep, multi-hop research on a topic, returned as a long-form Brief.',
  registration: 'subcommand',
  arguments: [
    argument('topic', { description: 'topic to research from web sources', required: true }),
  ],
  options: [
    ...AGENT_GROUPS,
    { group: 'browser-selection' },
    option('--no-browse', 'run research without the read-only browser for this run', {
      precedence: [
        { source: 'flag' },
        { source: 'preference', key: 'agent.research_browse' },
        { source: 'default', value: true },
      ],
      applicability: [{ mode: 'llm' }],
    }),
    option('--json', 'shorthand for --format json', { default: false }),
    option('--depth <hops>', 'number of research hops (1-3)', {
      default: '2',
      input: { kind: 'enum', choices: ['1', '2', '3'], enforced_by: 'parser' },
    }),
    option('--max-sources <n>', 'maximum sources to gather', {
      default: '24',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    // Unlike `ask`, research consults no preference for these: the commander
    // default is the effective default.
    option('--detail <level>', 'terminal disclosure level', {
      default: 'standard',
      input: DETAIL_CHOICES,
      precedence: [{ source: 'flag' }, { source: 'default', value: 'standard' }],
      applicability: [...TERMINAL_ONLY],
    }),
    formatOption(),
    option('--length <length>', 'final synthesis length budget', {
      default: 'long',
      input: LENGTH_CHOICES,
      precedence: [{ source: 'flag' }, { source: 'default', value: 'long' }],
    }),
    option('--open', 'open the generated brief.html in the default browser'),
    templateOption(),
    option('--no-color', 'disable ANSI color output'),
    option(
      '--search-provider <provider>',
      'search provider (default: auto walks tavily -> brave -> duckduckgo)',
      {
        input: SEARCH_PROVIDERS,
        precedence: [{ source: 'flag' }, { source: 'default', value: 'auto' }],
      },
    ),
    option('--max-llm-calls <n>', 'maximum LLM calls across the deterministic run', {
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option('--per-query-limit <n>', 'search results to consider per query', {
      default: '6',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option('--fetch-timeout <ms>', 'per-fetch timeout in ms', {
      default: '8000',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option(
      '--pipeline-timeout <duration>',
      'deterministic loop wall-clock timeout (for example 3m)',
      {
        default: '3m',
        input: { kind: 'duration' },
        applicability: [...DETERMINISTIC_ONLY],
      },
    ),
  ],
  execution: { default: 'run' },
  effect: 'external',
  danger: { level: 'none' },
  relations: [BROWSER_PATH_RELATION, TEMPLATE_NEEDS_LLM],
  exit_codes: [...BRIEF_EXITS],
  json: { flag: '--json', shape: 'document', schema: 'Brief' },
});

export const DO_HELP_AFTER =
  '\nProtect user-supplied values from the model with `@{value}` or `@password{value}`. ' +
  'Malformed markers are validation errors (exit 1).\n';

export const doCommand = leaf({
  id: 'do',
  description: 'Run a multi-turn web agent that uses Yantra tools and publishes a Brief.',
  help_after: DO_HELP_AFTER,
  registration: 'subcommand',
  aliases: ['discover'],
  arguments: [
    argument('goal', { description: 'browser or web goal to accomplish', required: true }),
  ],
  options: [
    ...AGENT_GROUPS,
    { group: 'agent-turn' },
    { group: 'browser-selection' },
    option('--allow-host <host>', 'restrict outbound work to a host (repeatable)', {
      repeatable: true,
      default: [],
    }),
    option(
      '--save-as <name>',
      'on success, promote the browser trace into a saved, replayable workflow',
    ),
    option('--json', 'emit progress and outcome as NDJSON', { default: false }),
    option('--open', 'open the generated brief.html in the default browser', { default: false }),
    templateOption(),
  ],
  execution: { default: 'run' },
  effect: 'external',
  danger: { level: 'none' },
  relations: [BROWSER_PATH_RELATION],
  exit_codes: [
    exit.ok('the task outcome was fulfilled'),
    exit.validation(
      `${PARSE_ERRORS}, an invalid model, budget or browser selection, the deterministic path (do requires an LLM), or a malformed @{…} marker`,
    ),
    exit.execution('the run failed or was only partially fulfilled'),
    exit.environment('agent credentials are unavailable'),
    exit.handoff('the run handed off to the user'),
  ],
  json: { flag: '--json', shape: 'ndjson', schema: 'TaskEvent' },
});
