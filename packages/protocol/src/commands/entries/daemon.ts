/** The local scheduler service: `daemon start|stop|status`. */

import { debugOption, exit, group, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

export const daemon = group({
  id: 'daemon',
  description: 'Manage the local scheduler service',
  registration: 'added',
});

const DAEMON_ADAPTER = {
  id: 'daemon-control',
  executes_as: 'mutate',
  note: 'the app starts and stops the scheduler service through its own control surface',
} as const;

export const daemonStart = leaf({
  id: 'daemon.start',
  description: 'Start the scheduler daemon',
  registration: 'subcommand',
  options: [
    option('--foreground', 'Run in the foreground instead of detaching', { default: false }),
    debugOption('Verbose logging to stderr'),
  ],
  execution: { default: 'adapter', adapter: DAEMON_ADAPTER },
  effect: 'external',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('the daemon started, or stopped cleanly in the foreground'),
    exit.validation(`${PARSE_ERRORS}, or the daemon failed while running`),
    exit.environment('the local index is unavailable'),
  ],
  json: { flag: null, shape: 'none', schema: null },
});

export const daemonStop = leaf({
  id: 'daemon.stop',
  description: 'Stop the running scheduler daemon',
  registration: 'subcommand',
  options: [debugOption('Verbose logging to stderr')],
  execution: { default: 'adapter', adapter: DAEMON_ADAPTER },
  effect: 'local',
  danger: { level: 'confirm', reason: 'stops scheduled runs until the daemon is started again' },
  exit_codes: [
    exit.ok('stopped, or nothing was running'),
    exit.validation(`${PARSE_ERRORS}, or the stop failed`),
  ],
  json: { flag: null, shape: 'none', schema: null },
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
