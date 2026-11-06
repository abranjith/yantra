/** Yantra-owned browser installations: `browser install|list|use|check|update`. */

import { exit, group, jsonOption, leaf, PARSE_ERRORS } from './builders.js';

export const browser = group({
  id: 'browser',
  description: 'Manage Yantra-owned browser installations',
  registration: 'added',
});

export const browserList = leaf({
  id: 'browser.list',
  description:
    'List the browsers Yantra can use on this machine, with the current selection. Local only: no network, launch, install, or update check',
  registration: 'subcommand',
  options: [jsonOption('emit the inventory as JSON')],
  execution: { default: 'read' },
  effect: 'none',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('inventory reported, including an unavailable selection'),
    exit.validation(PARSE_ERRORS),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});
