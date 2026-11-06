/** Yantra-owned browser installations: `browser install|list|use|check|update`. */

import { BROWSER_PATH_RELATION } from './agentic.js';
import { argument, exit, group, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

export const browser = group({
  id: 'browser',
  description: 'Manage Yantra-owned browser installations',
  registration: 'added',
});

const NO_DANGER = { level: 'none' } as const;
const ACQUISITION_EXITS = [
  exit.validation(`${PARSE_ERRORS}, or acceptance missing under --json or without a TTY`),
  exit.environment('a host, network, helper, compatibility, publication or contention failure'),
  exit.handoff('the download was declined or cancelled'),
] as const;

export const browserInstall = leaf({
  id: 'browser.install',
  description: 'Download current Chrome for Testing Stable into Yantra-managed storage',
  registration: 'subcommand',
  options: [
    option('--yes', 'accept the download without prompting', { default: false }),
    jsonOption('emit exactly one JSON outcome'),
  ],
  execution: { default: 'exclusive' },
  effect: 'external',
  danger: NO_DANGER,
  exit_codes: [exit.ok('installed, or already current'), ...ACQUISITION_EXITS],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const browserList = leaf({
  id: 'browser.list',
  description:
    'List the browsers Yantra can use on this machine, with the current selection. Local only: no network, launch, install, or update check',
  registration: 'subcommand',
  options: [jsonOption('emit the inventory as JSON')],
  execution: { default: 'read' },
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok('inventory reported, including an unavailable selection'),
    exit.validation(PARSE_ERRORS),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const browserUse = leaf({
  id: 'browser.use',
  description:
    'Select which browser Yantra launches and persist it. Validates the path; never launches a browser or checks for updates',
  registration: 'subcommand',
  arguments: [
    argument('source', {
      description: 'auto, managed, or system',
      required: true,
      input: { kind: 'enum', choices: ['auto', 'managed', 'system'], enforced_by: 'handler' },
    }),
  ],
  options: [
    option('--path <absolute-executable>', 'custom external executable (only with `system`)', {
      input: { kind: 'path', target: 'file' },
    }),
    jsonOption('emit the committed selection as JSON'),
  ],
  execution: { default: 'mutate' },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown source, an invalid path, or a write failure`),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const browserCheck = leaf({
  id: 'browser.check',
  description:
    'Run a fresh local compatibility check against the selected browser, using isolated synthetic pages. No network: this does not look for a newer browser',
  registration: 'subcommand',
  options: [{ group: 'browser-selection' }, jsonOption('emit the compatibility report as JSON')],
  execution: { default: 'run' },
  effect: 'none',
  danger: NO_DANGER,
  relations: [BROWSER_PATH_RELATION],
  exit_codes: [
    exit.ok('the browser is compatible'),
    exit.validation(`${PARSE_ERRORS}, or an invalid browser selection`),
    exit.environment('no usable browser, or the compatibility check failed'),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const browserUpdate = leaf({
  id: 'browser.update',
  description:
    'Replace the Yantra-managed browser with current Chrome for Testing Stable. This is the only command that checks whether a newer browser exists; use --dry-run to report availability and download nothing',
  registration: 'subcommand',
  options: [
    option('--dry-run', 'report what is available without downloading or changing anything', {
      default: false,
    }),
    option('--yes', 'accept the replacement without prompting', { default: false }),
    jsonOption('emit exactly one JSON outcome'),
  ],
  execution: {
    default: 'exclusive',
    rules: [{ when: { option: '--dry-run', present: true }, class: 'read' }],
  },
  effect: 'external',
  danger: NO_DANGER,
  relations: [
    {
      kind: 'conflicts',
      option: '--dry-run',
      with: ['--yes'],
      note: '--dry-run reports availability and changes nothing, so there is nothing for --yes to accept',
    },
  ],
  exit_codes: [exit.ok('updated, up to date, or a newer build is installed'), ...ACQUISITION_EXITS],
  json: { flag: '--json', shape: 'envelope', schema: null },
});
