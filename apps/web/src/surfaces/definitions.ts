import { findLeaf } from '@yantra/protocol/commands';
import { APP_READ_SCHEMAS } from '@yantra/protocol/parity';

import { tableShape, type SchemaLike } from '../generated/table-model.js';

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

/** A row action: a command whose form opens prefilled from the row through `bind` pointers. */
export interface RowAction {
  readonly command: string;
  readonly label: string;
  /** Form field → JSON pointer into the row. */
  readonly bind: Readonly<Record<string, string>>;
}

/** One read a surface shows: a table of rows, or a record. */
export interface SurfaceRead {
  /** The CLI command, as typed after `yantra`. */
  readonly command: string;
  /** What the section shows, in words. */
  readonly title: string;
  readonly method: string;
  /** Positional arguments the host does not already add. */
  readonly args?: readonly string[];
  readonly view: 'table' | 'record';
  readonly schema: keyof typeof APP_READ_SCHEMAS;
  /** Actions on this read's rows; a record has none. */
  readonly rowActions?: readonly RowAction[];
}

export interface SurfaceDefinition {
  readonly id: SurfaceId;
  readonly route: string;
  readonly title: string;
  readonly group: 'settings' | 'library' | 'system';
  readonly reads: readonly SurfaceRead[];
  readonly actions: readonly string[];
  readonly notes?: readonly string[];
}

const CONFIG_PATH = {
  command: 'config path',
  title: 'Storage locations',
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
        title: 'config.yaml',
        method: 'read.config.list',
        view: 'record',
        schema: 'ConfigListResult',
      },
      {
        command: 'config validate',
        title: 'Validation',
        method: 'read.config.validate',
        view: 'record',
        schema: 'ConfigValidateResult',
      },
    ],
    // Storage locations are not config keys, so get and unset are page actions, not row actions.
    actions: ['config get', 'config set', 'config unset'],
  },
  {
    id: 'preferences',
    route: '/settings/preferences',
    title: 'Preferences',
    group: 'settings',
    reads: [
      {
        // The host's reader already adds the `list` action.
        command: 'prefs list',
        title: 'Stored preferences',
        method: 'read.prefs.list',
        view: 'table',
        schema: 'PrefsResult',
      },
      {
        command: 'profile',
        title: 'Effective profile',
        method: 'read.profile',
        view: 'table',
        schema: 'ProfileResult',
      },
    ],
    actions: ['prefs'],
  },
  {
    id: 'models',
    route: '/settings/models',
    title: 'Models',
    group: 'settings',
    reads: [
      {
        command: 'model list',
        title: 'Registered models',
        method: 'read.model.list',
        view: 'table',
        schema: 'ModelListResult',
        rowActions: [
          { command: 'model rm', label: 'Remove', bind: { id: '/id' } },
          { command: 'model default', label: 'Use by default', bind: { id: '/id' } },
        ],
      },
    ],
    actions: ['model add'],
  },
  {
    id: 'browser',
    route: '/settings/browser',
    title: 'Browser',
    group: 'settings',
    reads: [
      {
        command: 'browser list',
        title: 'Browsers',
        method: 'read.browser.list',
        view: 'record',
        schema: 'BrowserListResult',
      },
    ],
    actions: ['browser use', 'browser check', 'browser install', 'browser update'],
  },
  {
    id: 'sites',
    route: '/settings/sites',
    title: 'Sites',
    group: 'settings',
    reads: [
      {
        command: 'sites list',
        title: 'Ranked sites',
        method: 'read.sites.list',
        view: 'table',
        schema: 'SitesListResult',
        rowActions: [{ command: 'sites remove', label: 'Remove', bind: { domain: '/domain' } }],
      },
    ],
    actions: ['sites add'],
  },
  {
    id: 'data',
    route: '/settings/data',
    title: 'Data',
    group: 'settings',
    reads: [CONFIG_PATH],
    actions: [],
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
        title: 'Saved workflows',
        method: 'read.list',
        args: ['workflows'],
        view: 'table',
        schema: 'ListResult',
        rowActions: [
          { command: 'schedule', label: 'Schedule', bind: { 'workflow-name': '/name' } },
        ],
      },
    ],
    actions: ['lint'],
  },
  {
    id: 'templates',
    route: '/templates',
    title: 'Templates',
    group: 'library',
    reads: [
      {
        command: 'template list',
        title: 'Saved templates',
        method: 'read.template.list',
        view: 'table',
        schema: 'TemplateListResult',
        rowActions: [{ command: 'template remove', label: 'Remove', bind: { name: '/name' } }],
      },
    ],
    actions: ['template new', 'template lint', 'template save'],
  },
  {
    id: 'schedules',
    route: '/schedules',
    title: 'Schedules',
    group: 'library',
    reads: [
      {
        command: 'schedules',
        title: 'Registered schedules',
        method: 'read.schedules',
        view: 'table',
        schema: 'SchedulesResult',
        rowActions: [{ command: 'unschedule', label: 'Unschedule', bind: { id: '/id' } }],
      },
    ],
    actions: ['schedule'],
  },
  {
    id: 'usage',
    route: '/usage',
    title: 'Usage',
    group: 'system',
    reads: [
      {
        command: 'usage',
        title: 'Tasks and cost by day',
        method: 'read.usage',
        view: 'table',
        schema: 'UsageResult',
      },
    ],
    actions: [],
  },
  {
    id: 'daemon',
    route: '/daemon',
    title: 'Daemon',
    group: 'system',
    reads: [
      {
        command: 'daemon status',
        title: 'Status',
        method: 'read.daemon.status',
        view: 'record',
        schema: 'DaemonStatusResult',
      },
    ],
    actions: [],
  },
  {
    id: 'onboarding',
    route: '/onboarding',
    title: 'Onboarding',
    group: 'system',
    reads: [],
    actions: [],
    notes: ['Arrives with onboarding and Health (FEAT-071).'],
  },
  {
    id: 'health',
    route: '/health',
    title: 'Health',
    group: 'system',
    reads: [],
    actions: [],
    notes: ['Arrives with onboarding and Health (FEAT-071).'],
  },
  {
    id: 'credentials',
    route: '/settings/credentials',
    title: 'Credentials',
    group: 'settings',
    reads: [],
    actions: [],
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

/** Every row action on a surface, across its reads. */
export function surfaceRowActions(definition: SurfaceDefinition): readonly RowAction[] {
  return definition.reads.flatMap((read) => read.rowActions ?? []);
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
      // A table read must have one row array; tableShape throws otherwise.
      if (read.view === 'table') tableShape(schemaFor(read));
      if (read.view === 'record' && (read.rowActions?.length ?? 0) > 0)
        throw new Error(`${read.command} is a record and cannot have row actions`);
    }
    for (const command of [
      ...definition.actions,
      ...surfaceRowActions(definition).map((item) => item.command),
    ])
      if (findLeaf(command.split(' ')) === undefined) throw new Error(`Unknown command ${command}`);
  }
}
