/** Saved workflows: `run`, `resume`, `confirm`, `lint`, `schedule`, `schedules`, `unschedule`. */

import { debugOption, exit, jsonOption, leaf, PARSE_ERRORS } from './builders.js';

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
