/** Saved workflows: `run`, `resume`, `confirm`, `lint`, `schedule`, `schedules`, `unschedule`. */

import type { OptionSpecInput } from '../schema.js';

import { BROWSER_PATH_RELATION } from './agentic.js';
import { argument, debugOption, exit, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

const AGENT_GROUPS = [
  { group: 'agent-model' },
  { group: 'agent-budget' },
  { group: 'no-llm' },
  { group: 'screenshots' },
  { group: 'browser-selection' },
] as const;

const REPLAY_EXITS = [
  exit.ok('the workflow completed'),
  exit.validation(
    `${PARSE_ERRORS}, invalid parameters, --template (unsupported on run), or an invalid browser selection`,
  ),
  exit.execution('the run started and ended in failure'),
  exit.environment('the environment could not run the workflow'),
  exit.handoff('the run handed off to the user, or a browser install offer was declined'),
] as const;

const openOption = (): OptionSpecInput =>
  option('--open', 'open the generated brief.html in the default browser', { default: false });

export const run = leaf({
  id: 'run',
  description: 'Execute a saved workflow',
  registration: 'added',
  arguments: [
    argument('workflow-name', {
      description: 'Name of the workflow to run',
      required: true,
      input: { kind: 'workflow-ref' },
    }),
  ],
  options: [
    option('-p, --params <key=value...>', 'Workflow parameter (may be repeated)', {
      repeatable: true,
      default: [],
    }),
    option('--params-file <path>', 'YAML/JSON file of parameter key-value pairs', {
      input: { kind: 'path', target: 'file' },
    }),
    jsonOption('Emit JSON summary to stdout instead of a terminal card'),
    debugOption('Emit verbose debug logging to stderr'),
    openOption(),
    option('--template <ref>', 'report templates are supported on ask, research, and do', {
      input: { kind: 'template-ref' },
    }),
    ...AGENT_GROUPS,
  ],
  execution: { default: 'run' },
  effect: 'external',
  danger: { level: 'none' },
  relations: [BROWSER_PATH_RELATION],
  exit_codes: [...REPLAY_EXITS],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const resume = leaf({
  id: 'resume',
  description: 'Resume a previously failed or paused workflow run',
  registration: 'added',
  arguments: [
    argument('run-id', {
      description: 'Run ID to resume (from the run directory name)',
      required: true,
      input: { kind: 'run-ref' },
    }),
  ],
  options: [
    ...AGENT_GROUPS,
    jsonOption('Emit JSON summary to stdout'),
    debugOption('Emit verbose debug logging to stderr'),
    openOption(),
    option('--force', 'Skip the user-consent check for scope-violation / ethics-refused failures', {
      default: false,
      danger: {
        level: 'confirm',
        reason: 'resumes past a scope-violation or ethics refusal without the consent check',
      },
    }),
  ],
  execution: { default: 'run' },
  effect: 'external',
  danger: { level: 'none' },
  relations: [BROWSER_PATH_RELATION],
  exit_codes: [
    REPLAY_EXITS[0],
    REPLAY_EXITS[1],
    REPLAY_EXITS[2],
    REPLAY_EXITS[3],
    exit.handoff(
      'the run handed off again, or it needs consent (scope violation or ethics refusal) and --force was not given',
    ),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const schedules = leaf({
  id: 'schedules',
  description: 'List registered schedules',
  registration: 'added',
  options: [jsonOption('Emit JSON array to stdout'), debugOption('Verbose logging to stderr')],
  execution: { default: 'read' },
  effect: 'none',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('success, including an empty list when the local index is unavailable'),
    exit.validation(PARSE_ERRORS),
    exit.execution('the schedule store reported an error'),
  ],
  json: { flag: '--json', shape: 'document', schema: null },
});

export const confirm = leaf({
  id: 'confirm',
  description: 'Grant or deny a pending confirmation for a parked run',
  registration: 'added',
  arguments: [
    argument('run-id', {
      description: 'The run id with a pending confirmation',
      required: true,
      input: { kind: 'run-ref' },
    }),
    argument('decision', {
      description: 'grant | deny',
      required: true,
      input: { kind: 'enum', choices: ['grant', 'deny'], enforced_by: 'handler' },
    }),
  ],
  options: [jsonOption('Emit JSON summary to stdout'), debugOption('Verbose logging to stderr')],
  execution: {
    default: 'mutate',
    adapter: {
      id: 'confirm-inbox',
      executes_as: 'mutate',
      note: 'the Inbox answers through the shared consent service (D12)',
    },
  },
  effect: 'local',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('the decision was recorded'),
    exit.validation(`${PARSE_ERRORS}, an invalid decision, or no pending confirmation`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const lint = leaf({
  id: 'lint',
  description: 'Lint a workflow YAML file for errors and best-practice violations',
  registration: 'added',
  arguments: [
    argument('file', {
      description: 'Path to the workflow YAML file',
      required: true,
      input: { kind: 'path', target: 'file' },
    }),
  ],
  options: [
    option('--strict', 'Promote warnings to errors', { default: false }),
    jsonOption('Output lint report as JSON to stdout'),
  ],
  execution: { default: 'mutate' },
  effect: 'none',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('no errors (warnings allowed unless --strict)'),
    exit.validation(`${PARSE_ERRORS}, an unreadable file, or lint errors`),
  ],
  json: { flag: '--json', shape: 'document', schema: null },
});

export const schedule = leaf({
  id: 'schedule',
  description: 'Register a recurring unattended run of a saved workflow',
  registration: 'added',
  arguments: [
    argument('workflow-name', {
      description: 'Name of the saved workflow to schedule',
      required: true,
      input: { kind: 'workflow-ref' },
    }),
  ],
  options: [
    option('--cron <expr>', 'Cron expression (e.g. "0 8 * * 1")', { mandatory: true }),
    option('-p, --params <key=value...>', 'Workflow parameter (repeatable)', {
      repeatable: true,
      default: [],
    }),
    option('--params-file <path>', 'YAML/JSON file of parameter key-value pairs', {
      input: { kind: 'path', target: 'file' },
    }),
    option('--notify <target>', 'Notification sink: desktop | file | none', {
      default: 'desktop',
      input: { kind: 'enum', choices: ['desktop', 'file', 'none'], enforced_by: 'handler' },
    }),
    option('--on-confirm <policy>', 'Confirmation policy — only "pause-and-notify" is accepted', {
      default: 'pause-and-notify',
      input: { kind: 'enum', choices: ['pause-and-notify'], enforced_by: 'handler' },
    }),
    jsonOption('Emit JSON summary to stdout'),
    debugOption('Verbose logging to stderr'),
  ],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, an invalid cron, parameter, --notify or --on-confirm, or a workflow that cannot be scheduled`,
    ),
    exit.execution('the schedule store reported an error'),
    exit.environment('the local index is unavailable'),
  ],
  json: { flag: '--json', shape: 'document', schema: null },
});

export const unschedule = leaf({
  id: 'unschedule',
  description: 'Remove a registered schedule',
  registration: 'added',
  arguments: [
    argument('id', { description: 'Schedule id (from `yantra schedules`)', required: true }),
  ],
  options: [jsonOption('Emit JSON summary to stdout'), debugOption('Verbose logging to stderr')],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: { level: 'confirm', reason: 'removes the recurring schedule' },
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, or no schedule with that id`),
    exit.execution('the schedule store reported an error'),
    exit.environment('the local index is unavailable'),
  ],
  json: { flag: '--json', shape: 'document', schema: null },
});
