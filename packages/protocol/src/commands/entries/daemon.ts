/** The local scheduler service: `daemon start|stop|status`. */

import { debugOption, exit, group, jsonOption, leaf, PARSE_ERRORS } from './builders.js';

export const daemon = group({
  id: 'daemon',
  description: 'Manage the local scheduler service',
  registration: 'added',
});

export const daemonStatus = leaf({
  id: 'daemon.status',
  description: 'Report scheduler daemon status',
  registration: 'subcommand',
  options: [jsonOption('Emit JSON status to stdout'), debugOption('Verbose logging to stderr')],
  execution: { default: 'read' },
  effect: 'none',
  danger: { level: 'none' },
  exit_codes: [exit.ok('status reported, running or not'), exit.validation(PARSE_ERRORS)],
  json: { flag: '--json', shape: 'document', schema: null },
});
