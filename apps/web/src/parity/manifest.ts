import { COMMAND_REGISTRY, expandOptions, isKnownDeadOption } from '@yantra/protocol/commands';
import { RUN_ARTIFACT_REGISTRY } from '@yantra/protocol/parity';
import type { RunEventKind } from '@yantra/protocol/parity';

import { EVENT_ROUTES } from '../features/live/event-routes.js';
import { SURFACE_DEFINITIONS } from '../surfaces/definitions.js';

import type { OptionParity, ParityManifest, ParityTarget } from './types.js';

const instrumentOf = (kind: RunEventKind): ParityTarget => {
  const route = EVENT_ROUTES[kind][0];
  return route === undefined || route === 'inspector'
    ? { kind: 'inspector' }
    : { kind: 'instrument', instrument: route };
};

export const EVENT_PARITY = Object.fromEntries(
  (Object.keys(EVENT_ROUTES) as RunEventKind[]).map((kind) => [kind, instrumentOf(kind)]),
) as Readonly<Record<RunEventKind, ParityTarget>>;

function artifactTarget(entry: (typeof RUN_ARTIFACT_REGISTRY)[number]): ParityTarget {
  if (entry.exposure === 'denied') return { kind: 'denied', reason: entry.description };
  if (entry.exposure === 'download') return { kind: 'viewer', viewer: 'download' };
  if (entry.viewer === 'none') return { kind: 'denied', reason: entry.description };
  return { kind: 'viewer', viewer: entry.viewer };
}

export const ARTIFACT_PARITY: Readonly<Record<string, ParityTarget>> = Object.fromEntries(
  RUN_ARTIFACT_REGISTRY.map((entry) => [entry.id, artifactTarget(entry)] as const),
);

const REVIEWED = '2026-11-17' as const;
const generated = new Map<string, string>();
for (const surface of SURFACE_DEFINITIONS) {
  for (const read of surface.reads)
    generated.set(
      read.command === 'prefs list'
        ? 'prefs'
        : read.command === 'list workflows'
          ? 'list'
          : read.command,
      surface.id,
    );
  for (const command of surface.actions) generated.set(command, surface.id);
  for (const action of surface.rowActions) generated.set(action.command, surface.id);
}

function commandTarget(path: string): ParityTarget {
  const generatedSurface = generated.get(path);
  if (generatedSurface !== undefined) return { kind: 'surface', surface: generatedSurface };
  if (['ask', 'research', 'do', 'run', 'resume'].includes(path))
    return { kind: 'surface', surface: 'mission' };
  if (path === 'list') return { kind: 'surface', surface: 'ledger' };
  if (path === 'template show') return { kind: 'surface', surface: 'templates' };
  if (path === 'show' || path === 'report') return { kind: 'surface', surface: 'run-result' };
  if (path === 'audit') return { kind: 'surface', surface: 'audit' };
  if (path === 'confirm') return { kind: 'adapter', adapter: 'confirm-inbox', surface: 'inbox' };
  if (path === 'config edit')
    return { kind: 'adapter', adapter: 'config-edit-yaml', surface: 'installation' };
  if (path === 'open')
    return { kind: 'adapter', adapter: 'open-result-view', surface: 'run-result' };
  if (path === 'daemon start' || path === 'daemon stop')
    return { kind: 'adapter', adapter: 'daemon-control', surface: 'daemon' };
  if (path === 'ui')
    return { kind: 'exemption', reason: 'You are already in the app.', reviewed: REVIEWED };
  if (path === 'config data-dir')
    return {
      kind: 'exemption',
      reason: 'Close the app, run yantra config data-dir <path>, then run yantra ui.',
      reviewed: REVIEWED,
    };
  if (path === 'init') return { kind: 'reserved', feature: 'FEAT-071', surface: 'onboarding' };
  if (path === 'doctor') return { kind: 'reserved', feature: 'FEAT-071', surface: 'health' };
  if (path.startsWith('secret '))
    return { kind: 'reserved', feature: 'FEAT-071', surface: 'credentials' };
  throw new Error(`No parity target for ${path}`);
}

export const COMMAND_PARITY: Readonly<Record<string, ParityTarget>> = Object.fromEntries(
  COMMAND_REGISTRY.commands
    .filter((entry) => entry.kind === 'leaf')
    .map((entry) => [entry.path.join(' '), commandTarget(entry.path.join(' '))]),
);

function optionTarget(command: string, id: string, flag: string): OptionParity {
  if (isKnownDeadOption(id, flag)) return { kind: 'dead', allowlist: 'KNOWN_DEAD_OPTIONS' };
  if (flag === '--print' && command === 'open')
    return { kind: 'adapter_action', label: 'Copy path' };
  if (flag === '--json')
    return {
      kind: 'exemption',
      reason: 'The app shows structured results itself.',
      reviewed: REVIEWED,
    };
  if (flag === '--open')
    return { kind: 'exemption', reason: 'The app opens results itself.', reviewed: REVIEWED };
  if (flag === '--debug')
    return {
      kind: 'exemption',
      reason: 'Worker diagnostics are not rendered in the app.',
      reviewed: REVIEWED,
    };
  if (flag === '--foreground' && command === 'daemon start')
    return {
      kind: 'exemption',
      reason: 'The app always detaches the scheduler daemon.',
      reviewed: REVIEWED,
    };
  if (flag === '--print' && command === 'ui')
    return { kind: 'exemption', reason: 'The app is already open.', reviewed: REVIEWED };
  return { kind: 'field' };
}

export const OPTION_PARITY: Readonly<Record<string, OptionParity>> = Object.fromEntries(
  COMMAND_REGISTRY.commands.flatMap((entry) =>
    entry.kind === 'leaf'
      ? expandOptions(entry, COMMAND_REGISTRY.option_groups).map((option) => {
          const command = entry.path.join(' ');
          return [`${command} ${option.long}`, optionTarget(command, entry.id, option.long)];
        })
      : [],
  ),
);

export const PARITY_MANIFEST: ParityManifest = {
  commands: COMMAND_PARITY,
  options: OPTION_PARITY,
  events: EVENT_PARITY,
  artifacts: ARTIFACT_PARITY,
};
