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

/**
 * A page action: a command's form, opened from a button with a plain-word
 * label. The button shows the exact `yantra …` command on hover.
 */
export interface SurfaceAction {
  readonly command: string;
  readonly label: string;
  /** The page's one main action, drawn in Ion. */
  readonly primary?: boolean;
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
  /** Columns set in the engine's mono voice: ids, paths, keys, cron. */
  readonly engine?: readonly string[];
}

export interface SurfaceDefinition {
  readonly id: SurfaceId;
  readonly route: string;
  readonly title: string;
  /** What the page is for, in one sentence. */
  readonly description?: string;
  readonly group: 'settings' | 'library' | 'system';
  readonly reads: readonly SurfaceRead[];
  readonly actions: readonly SurfaceAction[];
  readonly notes?: readonly string[];
}

const CONFIG_PATH = {
  command: 'config path',
  title: 'Storage locations',
  method: 'read.config.path',
  view: 'table',
  schema: 'ConfigPathResult',
  engine: ['path'],
} as const;
export const SURFACE_DEFINITIONS: readonly SurfaceDefinition[] = [
  {
    id: 'installation',
    route: '/settings/installation',
    title: 'Installation',
    description:
      'What is installed on this machine: where Yantra keeps its files, and the settings in config.yaml.',
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
    // Storage locations are not config keys, so these are page actions, not row actions.
    actions: [
      { command: 'config set', label: 'Set a value', primary: true },
      { command: 'config get', label: 'Look up a value' },
      { command: 'config unset', label: 'Remove a value' },
    ],
  },
  {
    id: 'preferences',
    route: '/settings/preferences',
    title: 'Preferences',
    description:
      'How you like runs to behave: the model, budgets, timeouts and what context Yantra may use.',
    group: 'settings',
    reads: [
      {
        // The host's reader already adds the `list` action.
        command: 'prefs list',
        title: 'Stored preferences',
        method: 'read.prefs.list',
        view: 'table',
        schema: 'PrefsResult',
        engine: ['key', 'value'],
      },
      {
        command: 'profile',
        title: 'Effective profile',
        method: 'read.profile',
        view: 'table',
        schema: 'ProfileResult',
        engine: ['key', 'value'],
      },
    ],
    actions: [{ command: 'prefs', label: 'Change a preference', primary: true }],
  },
  {
    id: 'models',
    route: '/settings/models',
    title: 'Models',
    description: 'The models Yantra can use, and which one runs by default.',
    group: 'settings',
    reads: [
      {
        command: 'model list',
        title: 'Registered models',
        method: 'read.model.list',
        view: 'table',
        schema: 'ModelListResult',
        engine: ['id'],
        rowActions: [
          { command: 'model default', label: 'Use by default', bind: { id: '/id' } },
          { command: 'model rm', label: 'Remove', bind: { id: '/id' } },
        ],
      },
    ],
    actions: [{ command: 'model add', label: 'Add a model', primary: true }],
  },
  {
    id: 'browser',
    route: '/settings/browser',
    title: 'Browser',
    description: 'The Chrome that Yantra drives: which one it uses, and the copy it manages.',
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
    actions: [
      { command: 'browser use', label: 'Choose a browser', primary: true },
      { command: 'browser check', label: 'Check compatibility' },
      { command: 'browser install', label: 'Install Chrome for Testing' },
      { command: 'browser update', label: 'Update the managed browser' },
    ],
  },
  {
    id: 'sites',
    route: '/settings/sites',
    title: 'Sites',
    description:
      'How Yantra ranks the sites it reads. Research runs rank them; you can add your own.',
    group: 'settings',
    reads: [
      {
        command: 'sites list',
        title: 'Ranked sites',
        method: 'read.sites.list',
        view: 'table',
        schema: 'SitesListResult',
        engine: ['domain'],
        rowActions: [{ command: 'sites remove', label: 'Remove', bind: { domain: '/domain' } }],
      },
    ],
    actions: [{ command: 'sites add', label: 'Add a site', primary: true }],
  },
  {
    id: 'data',
    route: '/settings/data',
    title: 'Data',
    description:
      'Where runs, workflows and templates are kept. Only the data and cache folders can move.',
    group: 'settings',
    reads: [CONFIG_PATH],
    actions: [],
    notes: ['Close the app.', 'Run yantra config data-dir <path>.', 'Run yantra ui.'],
  },
  {
    id: 'workflows',
    route: '/workflows',
    title: 'Workflows',
    description:
      'A saved workflow replays a recorded task step by step. A model never steers a replay.',
    group: 'library',
    reads: [
      {
        command: 'list workflows',
        title: 'Saved workflows',
        method: 'read.list',
        args: ['workflows'],
        view: 'table',
        schema: 'ListResult',
        engine: ['name'],
        rowActions: [
          { command: 'schedule', label: 'Schedule', bind: { 'workflow-name': '/name' } },
        ],
      },
    ],
    actions: [{ command: 'lint', label: 'Check a workflow file' }],
  },
  {
    id: 'templates',
    route: '/templates',
    title: 'Templates',
    description: 'Report templates shape a run’s document: its sections, tables and guidance.',
    group: 'library',
    reads: [
      {
        command: 'template list',
        title: 'Saved templates',
        method: 'read.template.list',
        view: 'table',
        schema: 'TemplateListResult',
        engine: ['name', 'path'],
        rowActions: [{ command: 'template remove', label: 'Remove', bind: { name: '/name' } }],
      },
    ],
    actions: [
      { command: 'template new', label: 'New template', primary: true },
      { command: 'template save', label: 'Save a template file' },
      { command: 'template lint', label: 'Check a template' },
    ],
  },
  {
    id: 'schedules',
    route: '/schedules',
    title: 'Schedules',
    description: 'Saved workflows that run on their own, on a cron schedule, without a model.',
    group: 'library',
    reads: [
      {
        command: 'schedules',
        title: 'Registered schedules',
        method: 'read.schedules',
        view: 'table',
        schema: 'SchedulesResult',
        engine: ['id', 'workflowName', 'cronExpr'],
        rowActions: [{ command: 'unschedule', label: 'Unschedule', bind: { id: '/id' } }],
      },
    ],
    actions: [{ command: 'schedule', label: 'Schedule a workflow', primary: true }],
  },
  {
    id: 'usage',
    route: '/usage',
    title: 'Usage',
    description: 'How many tasks ran each day, and what they cost.',
    group: 'system',
    reads: [
      {
        command: 'usage',
        title: 'Tasks and cost by day',
        method: 'read.usage',
        view: 'table',
        schema: 'UsageResult',
        engine: ['day', 'taskCount', 'totalCostUsd'],
      },
    ],
    actions: [],
  },
  {
    id: 'daemon',
    route: '/daemon',
    title: 'Daemon',
    description: 'The background scheduler that fires your schedules. It never uses a model.',
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
    if (definition.actions.filter((action) => action.primary === true).length > 1)
      throw new Error(`${definition.id} has more than one primary action`);
    for (const command of [
      ...definition.actions.map((action) => action.command),
      ...surfaceRowActions(definition).map((item) => item.command),
    ])
      if (findLeaf(command.split(' ')) === undefined) throw new Error(`Unknown command ${command}`);
  }
}
