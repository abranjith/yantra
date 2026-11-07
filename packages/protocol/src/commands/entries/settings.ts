/** Installation and personalization settings: `config`, `secret`, `model`, `prefs`, `profile`, `sites`, `init`. */

import {
  argument,
  debugOption,
  exit,
  group,
  jsonOption,
  leaf,
  option,
  PARSE_ERRORS,
} from './builders.js';

const NO_DANGER = { level: 'none' } as const;
const READ = { default: 'read' } as const;
const CONFIG_JSON = { flag: '--json', shape: 'envelope', schema: null } as const;
const emitJson = () => jsonOption('emit JSON');
const MUTATE = { default: 'mutate' } as const;
const SECURE = { default: 'in-process-secure' } as const;
const confirm = (reason: string) => ({ level: 'confirm', reason }) as const;

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

export const configSet = leaf({
  id: 'config.set',
  description: '',
  registration: 'subcommand',
  arguments: [argument('key', { required: true }), argument('value', { required: true })],
  options: [emitJson()],
  execution: MUTATE,
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, an unknown or preference-owned key, an invalid YAML value, or a write failure`,
    ),
  ],
  json: CONFIG_JSON,
});

export const configUnset = leaf({
  id: 'config.unset',
  description: '',
  registration: 'subcommand',
  arguments: [argument('key', { required: true })],
  options: [emitJson()],
  execution: MUTATE,
  effect: 'local',
  danger: confirm('removes the setting from config.yaml'),
  exit_codes: [exit.ok(), exit.validation(`${PARSE_ERRORS}, an unknown key, or a write failure`)],
  json: CONFIG_JSON,
});

export const configEdit = leaf({
  id: 'config.edit',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: {
    default: 'adapter',
    adapter: {
      id: 'config-edit-yaml',
      note: 'a raw-YAML editor with validate replaces launching $EDITOR',
    },
  },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, $EDITOR unset or failing, or an invalid result (the original file is restored)`,
    ),
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

export const configDataDir = leaf({
  id: 'config.data-dir',
  description: '',
  registration: 'subcommand',
  arguments: [argument('path', { required: false, input: { kind: 'path', target: 'dir' } })],
  options: [
    option('--force', 'allow a non-empty target', {
      default: false,
      danger: confirm('merges into a non-empty target directory'),
    }),
    option('--no-move', 'write the setting without moving content', {
      danger: confirm('points Yantra at the new directory and leaves existing data behind'),
    }),
    option('--dry-run', 'print the relocation plan without changing anything', {
      default: false,
    }),
    emitJson(),
  ],
  execution: {
    default: 'exemption',
    exemption: {
      decision: 'D15',
      reason:
        'relocation moves the directory that holds the host lock, queue and sockets, so it cannot run under a live host',
    },
  },
  effect: 'local',
  danger: confirm('relocates the Yantra data directory'),
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, an invalid or nested target, a non-empty target without --force, or a live run`,
    ),
    exit.execution('the move failed part way (inspecting or removing a directory)'),
  ],
  json: CONFIG_JSON,
});

export const secret = group({
  id: 'secret',
  description: 'Manage credentials in the OS keychain',
  registration: 'added',
});

const KEYCHAIN_EXITS = [
  exit.validation(`${PARSE_ERRORS}, or an invalid key or value`),
  exit.environment('the OS keychain is unavailable'),
] as const;

export const secretSet = leaf({
  id: 'secret.set',
  description: '',
  registration: 'subcommand',
  arguments: [
    argument('key', { required: true }),
    argument('value', { required: false, input: { kind: 'secret-input' } }),
  ],
  options: [emitJson()],
  execution: SECURE,
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [exit.ok(), ...KEYCHAIN_EXITS],
  json: CONFIG_JSON,
});

export const secretList = leaf({
  id: 'secret.list',
  description: '',
  registration: 'subcommand',
  options: [emitJson()],
  execution: SECURE,
  effect: 'none',
  danger: NO_DANGER,
  exit_codes: [exit.ok('names listed; values are never shown'), ...KEYCHAIN_EXITS],
  json: CONFIG_JSON,
});

export const secretRm = leaf({
  id: 'secret.rm',
  description: '',
  registration: 'subcommand',
  arguments: [argument('key', { required: true })],
  options: [emitJson()],
  execution: SECURE,
  effect: 'local',
  danger: confirm('deletes the credential from the OS keychain'),
  exit_codes: [exit.ok(), ...KEYCHAIN_EXITS],
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

export const modelAdd = leaf({
  id: 'model.add',
  description: '',
  registration: 'subcommand',
  arguments: [argument('id', { required: true })],
  options: [
    option('--provider <provider>', '', { mandatory: true }),
    option('--base-url <url>', ''),
    option('--api-key-ref <reference>', ''),
    option('--input <kinds>', 'comma-separated: text,image', { default: 'text' }),
    option('--force', 'replace an existing provider/id pair', {
      default: false,
      danger: confirm('replaces the registered model with the same provider and id'),
    }),
    emitJson(),
  ],
  execution: MUTATE,
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(
      `${PARSE_ERRORS}, an empty provider, a literal key, an unknown input kind, an existing model without --force, or a write failure`,
    ),
  ],
  json: CONFIG_JSON,
});

export const modelRm = leaf({
  id: 'model.rm',
  description: '',
  registration: 'subcommand',
  arguments: [argument('id', { required: true })],
  options: [
    option('--force', 'remove even when selected as default', {
      default: false,
      danger: confirm('removes the model even though it is the selected default'),
    }),
    emitJson(),
  ],
  execution: MUTATE,
  effect: 'local',
  danger: confirm('removes the model from the registry'),
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown or ambiguous id, or the default without --force`),
  ],
  json: CONFIG_JSON,
});

export const modelDefault = leaf({
  id: 'model.default',
  description: '',
  registration: 'subcommand',
  arguments: [argument('id', { required: true })],
  options: [emitJson()],
  execution: MUTATE,
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown or ambiguous id, or an invalid profile`),
  ],
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

export const prefs = leaf({
  id: 'prefs',
  description: 'Manage personalization preferences (machine layer + merged view)',
  registration: 'added',
  arguments: [
    argument('action', {
      description: 'get | set | list | approve',
      required: false,
      input: { kind: 'enum', choices: ['get', 'set', 'list', 'approve'], enforced_by: 'handler' },
    }),
    argument('key', {
      description: 'dotted preference key (e.g. defaults.detail)',
      required: false,
    }),
    argument('value', { description: 'value (for set)', required: false }),
  ],
  options: [
    emitJson(),
    debugOption('verbose logging on stderr'),
    option('--forget <key>', 'delete a preference value (privacy control)', {
      danger: confirm('deletes a stored preference value'),
    }),
  ],
  execution: {
    default: 'read',
    rules: [
      { when: { argument: 'action', in: ['set', 'approve'] }, class: 'mutate' },
      { when: { option: '--forget', present: true }, class: 'mutate' },
    ],
  },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown action or key, or an invalid value`),
    exit.environment('the local preference index is unavailable'),
  ],
  json: CONFIG_JSON,
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

export const sitesAdd = leaf({
  id: 'sites.add',
  description: 'Add or promote a user-curated domain',
  registration: 'subcommand',
  arguments: [argument('domain', { description: 'hostname such as example.com', required: true })],
  options: [emitJson(), debugOption('verbose logging on stderr')],
  execution: MUTATE,
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an invalid domain, or a ranking store error`),
    exit.environment('the site ranking index is unavailable'),
  ],
  json: CONFIG_JSON,
});

export const sitesRemove = leaf({
  id: 'sites.remove',
  description: 'Remove a domain from local ranking',
  registration: 'subcommand',
  arguments: [argument('domain', { description: 'hostname such as example.com', required: true })],
  options: [emitJson(), debugOption('verbose logging on stderr')],
  execution: MUTATE,
  effect: 'local',
  danger: confirm('removes the domain from local ranking'),
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, a domain that is not ranked, or a ranking store error`),
    exit.environment('the site ranking index is unavailable'),
  ],
  json: CONFIG_JSON,
});

export const init = leaf({
  id: 'init',
  description: 'Create or update ~/.yantra/config.yaml',
  registration: 'added',
  options: [
    // Deliberately not the agent-model group's spelling: this selects the
    // installation's default provider, and only these three are accepted.
    option('--provider <name>', "default model provider: 'anthropic' | 'ollama' | 'none'", {
      input: { kind: 'enum', choices: ['anthropic', 'ollama', 'none'], enforced_by: 'handler' },
    }),
    option('--reset', 'back up existing files and rewrite from defaults', {
      default: false,
      danger: confirm('backs up and rewrites config.yaml and profile.yaml from defaults'),
    }),
    jsonOption('emit a JSON status object after writing'),
    option('--yes', 'accept defaults without prompting', { default: false }),
  ],
  execution: {
    default: 'adapter',
    adapter: {
      id: 'init-onboarding',
      executes_as: 'mutate',
      note: 'onboarding over the shared init service with a browser answer collector (FEAT-071)',
    },
  },
  effect: 'local',
  danger: NO_DANGER,
  exit_codes: [
    exit.ok(),
    exit.validation(`${PARSE_ERRORS}, an unknown provider, or a write failure`),
  ],
  json: { flag: '--json', shape: 'document', schema: null },
});
