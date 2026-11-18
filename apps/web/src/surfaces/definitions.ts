import { findLeaf } from '@yantra/protocol/commands';
import { APP_READ_SCHEMAS } from '@yantra/protocol/parity';

import type { SchemaLike } from '../generated/table-model.js';

export type SurfaceId =
  | 'installation'
  | 'preferences'
  | 'models'
  | 'browser'
  | 'sites'
  | 'data'
  | 'workflows'
  | 'templates'
  | 'schedules'
  | 'usage'
  | 'daemon'
  | 'health'
  | 'credentials'
  | 'onboarding';
export interface SurfaceRead {
  readonly command: string;
  readonly method: string;
  readonly args?: readonly string[];
  readonly view: 'table' | 'record' | 'text';
  readonly schema: keyof typeof APP_READ_SCHEMAS;
}
export interface RowAction {
  readonly command: string;
  readonly label: string;
  readonly bind: Readonly<Record<string, string>>;
}
export interface SurfaceDefinition {
  readonly id: SurfaceId;
  readonly route: string;
  readonly title: string;
  readonly group: 'settings' | 'library' | 'system';
  readonly reads: readonly SurfaceRead[];
  readonly actions: readonly string[];
  readonly rowActions: readonly RowAction[];
  readonly notes?: readonly string[];
}

const CONFIG_PATH = {
  command: 'config path',
  method: 'read.config.path',
  view: 'table',
  schema: 'ConfigPathResult',
} as const;
export const SURFACE_DEFINITIONS: readonly SurfaceDefinition[] = [
  {
    id: 'installation',
    route: '/settings/installation',
    title: 'Installation',
    group: 'settings',
    reads: [
      CONFIG_PATH,
      {
        command: 'config list',
        method: 'read.config.list',
        view: 'record',
        schema: 'ConfigListResult',
      },
      {
        command: 'config validate',
        method: 'read.config.validate',
        view: 'record',
        schema: 'ConfigValidateResult',
      },
    ],
    actions: ['config set', 'config unset'],
    rowActions: [
      { command: 'config get', label: 'Get', bind: { key: '/name' } },
      { command: 'config unset', label: 'Unset', bind: { key: '/name' } },
    ],
  },
  {
    id: 'preferences',
    route: '/settings/preferences',
    title: 'Preferences',
    group: 'settings',
    reads: [
      {
        command: 'prefs list',
        method: 'read.prefs.list',
        args: ['list'],
        view: 'table',
        schema: 'PrefsResult',
      },
      { command: 'profile', method: 'read.profile', view: 'record', schema: 'ProfileResult' },
    ],
    actions: ['prefs'],
    rowActions: [],
  },
  {
    id: 'models',
    route: '/settings/models',
    title: 'Models',
    group: 'settings',
    reads: [
      {
        command: 'model list',
        method: 'read.model.list',
        view: 'table',
        schema: 'ModelListResult',
      },
    ],
    actions: ['model add'],
    rowActions: [
      { command: 'model rm', label: 'Remove', bind: { id: '/id' } },
      { command: 'model default', label: 'Use by default', bind: { id: '/id' } },
    ],
  },
  {
    id: 'browser',
    route: '/settings/browser',
    title: 'Browser',
    group: 'settings',
    reads: [
      {
        command: 'browser list',
        method: 'read.browser.list',
        view: 'record',
        schema: 'BrowserListResult',
      },
    ],
    actions: ['browser use', 'browser check', 'browser install', 'browser update'],
    rowActions: [],
  },
  {
    id: 'sites',
    route: '/settings/sites',
    title: 'Sites',
    group: 'settings',
    reads: [
      {
        command: 'sites list',
        method: 'read.sites.list',
        view: 'table',
        schema: 'SitesListResult',
      },
    ],
    actions: ['sites add'],
    rowActions: [{ command: 'sites remove', label: 'Remove', bind: { domain: '/domain' } }],
  },
  {
    id: 'data',
    route: '/settings/data',
    title: 'Data',
    group: 'settings',
    reads: [CONFIG_PATH],
    actions: [],
    rowActions: [],
    notes: ['Close the app.', 'Run yantra config data-dir <path>.', 'Run yantra ui.'],
  },
  {
    id: 'workflows',
    route: '/workflows',
    title: 'Workflows',
    group: 'library',
    reads: [
      {
        command: 'list workflows',
        method: 'read.list',
        args: ['workflows'],
        view: 'table',
        schema: 'ListResult',
      },
    ],
    actions: ['lint'],
    rowActions: [{ command: 'schedule', label: 'Schedule', bind: { 'workflow-name': '/name' } }],
  },
  {
    id: 'templates',
    route: '/templates',
    title: 'Templates',
    group: 'library',
    reads: [
      {
        command: 'template list',
        method: 'read.template.list',
        view: 'table',
        schema: 'TemplateListResult',
      },
    ],
    actions: ['template new', 'template lint', 'template save'],
    rowActions: [{ command: 'template remove', label: 'Remove', bind: { name: '/name' } }],
  },
  {
    id: 'schedules',
    route: '/schedules',
    title: 'Schedules',
    group: 'library',
    reads: [
      { command: 'schedules', method: 'read.schedules', view: 'table', schema: 'SchedulesResult' },
    ],
    actions: ['schedule'],
    rowActions: [{ command: 'unschedule', label: 'Unschedule', bind: { id: '/id' } }],
  },
  {
    id: 'usage',
    route: '/usage',
    title: 'Usage',
    group: 'system',
    reads: [{ command: 'usage', method: 'read.usage', view: 'table', schema: 'UsageResult' }],
    actions: [],
    rowActions: [],
  },
  {
    id: 'daemon',
    route: '/daemon',
    title: 'Daemon',
    group: 'system',
    reads: [
      {
        command: 'daemon status',
        method: 'read.daemon.status',
        view: 'record',
        schema: 'DaemonStatusResult',
      },
    ],
    actions: [],
    rowActions: [],
  },
  {
    id: 'onboarding',
    route: '/onboarding',
    title: 'Onboarding',
    group: 'system',
    reads: [],
    actions: [],
    rowActions: [],
    notes: ['Arrives with onboarding and Health (FEAT-071).'],
  },
  {
    id: 'health',
    route: '/health',
    title: 'Health',
    group: 'system',
    reads: [],
    actions: [],
    rowActions: [],
    notes: ['Arrives with onboarding and Health (FEAT-071).'],
  },
  {
    id: 'credentials',
    route: '/settings/credentials',
    title: 'Credentials',
    group: 'settings',
    reads: [],
    actions: [],
    rowActions: [],
    notes: ['Arrives with onboarding and Health (FEAT-071).'],
  },
];

export function surfaceById(id: SurfaceId): SurfaceDefinition {
  const found = SURFACE_DEFINITIONS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`Unknown surface ${id}`);
  return found;
}
export function schemaFor(read: SurfaceRead): SchemaLike {
  return APP_READ_SCHEMAS[read.schema];
}
export function assertDefinitions(
  definitions: readonly SurfaceDefinition[] = SURFACE_DEFINITIONS,
): void {
  for (const definition of definitions) {
    for (const read of definition.reads) {
      const path =
        read.command === 'list workflows'
          ? ['list']
          : read.command === 'prefs list'
            ? ['prefs']
            : read.command.split(' ');
      const command = findLeaf(path);
      if (command?.execution.default !== 'read')
        throw new Error(`${read.command} is not a read command`);
      if (command.json.schema === null) throw new Error(`${read.command} has no JSON schema`);
    }
    for (const command of [
      ...definition.actions,
      ...definition.rowActions.map((item) => item.command),
    ])
      if (findLeaf(command.split(' ')) === undefined) throw new Error(`Unknown command ${command}`);
  }
}
