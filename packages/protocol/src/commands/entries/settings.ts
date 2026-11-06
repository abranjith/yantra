/** Installation and personalization settings: `config`, `secret`, `model`, `prefs`, `profile`, `sites`, `init`. */

import { debugOption, exit, group, jsonOption, leaf, argument, PARSE_ERRORS } from './builders.js';

const NO_DANGER = { level: 'none' } as const;
const READ = { default: 'read' } as const;
const CONFIG_JSON = { flag: '--json', shape: 'envelope', schema: null } as const;
const emitJson = () => jsonOption('emit JSON');

export const config = group({
  id: 'config',
  description: 'Inspect and update installation configuration',
  registration: 'added',
});

export const configPath = leaf({
  id: 'config.path',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(PARSE_ERRORS)],
  json: CONFIG_JSON,
});

export const configList = leaf({
  id: 'config.list',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(`${PARSE_ERRORS}, or config.yaml is invalid`)],
  json: CONFIG_JSON,
});

export const configGet = leaf({
  id: 'config.get',
  description: '',
  registration: 'subcommand',
  arguments: [argument('key', { required: true })],
  options: [emitJson()],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown key, or config.yaml is invalid`),
  ],
  json: CONFIG_JSON,
});

export const configValidate = leaf({
  id: 'config.validate',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok('config.yaml is valid'), exit.validation(`${PARSE_ERRORS}, or invalid`)],
  json: CONFIG_JSON,
});

export const model = group({
  id: 'model',
  description: 'Manage the installed model registry',
  registration: 'added',
});

export const modelList = leaf({
  id: 'model.list',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(`${PARSE_ERRORS}, or config.yaml is invalid`)],
  json: CONFIG_JSON,
});

export const profile = leaf({
  id: 'profile',
  description: 'Show your effective personalization profile and its provenance',
  registration: 'added',
  options: [emitJson(), debugOption('verbose logging on stderr')],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), exit.validation(PARSE_ERRORS)],
  json: { flag: '--json', shape: 'envelope', schema: null },
});

export const sites = group({
  id: 'sites',
  description: 'Inspect and curate local website ranks',
  registration: 'added',
});

export const sitesList = leaf({
  id: 'sites.list',
  description: 'List ranked domains',
  registration: 'subcommand',
  options: [emitJson(), debugOption('verbose logging on stderr')],
  execution: READ,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, or the ranking store reported an error`),
    exit.environment('the site ranking index is unavailable'),
  ],
  json: CONFIG_JSON,
});
