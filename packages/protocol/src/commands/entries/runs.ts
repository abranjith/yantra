/** Run and workflow inspection: `list`, `show`, `usage`, `audit`, `report` (and `open`, TASK-007). */

import { argument, debugOption, exit, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

const runRef = { kind: 'run-ref' } as const;
const NO_DANGER = { level: 'none' } as const;
const READ = { default: 'read' } as const;

export const list = leaf({
  id: 'list',
  description: 'List saved workflows or recent runs',
  registration: 'added',
  arguments: [
    argument('target', {
      description: 'workflows | runs',
      required: false,
      default: 'runs',
      input: { kind: 'enum', choices: ['workflows', 'runs'], enforced_by: 'handler' },
    }),
  ],
  options: [
    option('--limit <n>', 'maximum number of entries to show', {
      default: '20',
      input: { kind: 'number', integer: true, min: 1 },
    }),
    option('--workflow <name>', 'filter runs by workflow name', {
      input: { kind: 'workflow-ref' },
    }),
    option('--status <s>', 'filter runs by status (running|completed|failed|aborted|paused)'),
    jsonOption('emit JSON instead of a terminal table'),
    debugOption('verbose logging on stderr'),
  ],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown target, or a listing failure`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const show = leaf({
  id: 'show',
  description: 'Display a saved workflow or run',
  registration: 'added',
  arguments: [argument('target', { description: 'Workflow name OR run-id', required: true })],
  options: [
    option('--workflow', 'force workflow lookup'),
    option('--run', 'force run lookup'),
    option('--events <n>', 'number of recent events to display for a run', {
      default: '20',
      input: { kind: 'number', integer: true, min: 0 },
    }),
    jsonOption('emit JSON instead of human-readable output'),
  ],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, or the workflow or run cannot be found or loaded`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const usage = leaf({
  id: 'usage',
  description: 'Summarize task volume and cost from the history index',
  registration: 'added',
  options: [
    option('--type <type>', 'filter by task type (ask|research|run|do)', {
      input: { kind: 'enum', choices: ['ask', 'research', 'run', 'do'], enforced_by: 'handler' },
    }),
    option('--since <when>', 'only tasks since a date (YYYY-MM-DD) or age (e.g. 7d, 24h)'),
    jsonOption('emit JSON instead of a table'),
    debugOption('verbose logging on stderr'),
  ],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok('success, including an empty result when the history index is unavailable'),
    exit.validation(`${PARSE_ERRORS}, an unknown --type or --since, or a rollup failure`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const audit = leaf({
  id: 'audit',
  description: 'Render a run directory as a readable audit story',
  registration: 'added',
  arguments: [argument('run-id', { required: true, input: runRef })],
  options: [jsonOption('emit JSON instead of prose')],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(`${PARSE_ERRORS}, an unknown run, or an audit failure`)],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const report = leaf({
  id: 'report',
  description: "Open or print a run's report.md",
  registration: 'added',
  arguments: [argument('run-id', { required: true, input: runRef })],
  options: [
    option('--open', 'open report.md in $EDITOR (or platform default)', { default: false }),
    jsonOption('emit the markdown wrapped in a JSON envelope'),
  ],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  relations: [
    {
      kind: 'conflicts',
      option: '--open',
      with: ['--json'],
      note: '--open is interactive and cannot be combined with --json',
    },
  ],
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown run, a missing report.md, or --open with --json`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});
