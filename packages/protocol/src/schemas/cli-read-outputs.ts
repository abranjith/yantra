import { z } from 'zod';

import { CLI_READ_SCHEMA_VERSION } from './cli-reads.js';

/**
 * `--json` documents of the read-class commands the app's generated surfaces
 * render (FEAT-070 TASK-002). Each schema describes the output **as the CLI
 * prints it today**: these are descriptions, not a redesign, and the CLI's
 * output is unchanged (plan_ui §8 Compatibility).
 *
 * Most documents are an envelope (`schemaVersion`, `kind`, body). Two are
 * not, and are modeled as they are: `yantra schedules --json` prints a bare
 * array, and `yantra daemon status --json` prints the status object alone.
 *
 * Rows produced by an internal record (a schedule, a preference) are
 * `passthrough`: the named fields are pinned, and a field added there later
 * does not break the app.
 */

const version = z
  .literal(CLI_READ_SCHEMA_VERSION)
  .describe('The protocol schema version every CLI `--json` envelope carries.');

const envelope = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S, what: string) =>
  z
    .object({
      schemaVersion: version,
      kind: z.literal(kind).describe(`Always \`${kind}\`.`),
      ...shape,
    })
    .strict()
    .describe(what);

const isoTime = z.string().min(1).describe('ISO-8601 timestamp.');

// ---------------------------------------------------------------- config

/** One storage location in `yantra config path --json`. */
export const ConfigPathRow = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('What the location is: home, config, profile, data, cache, runs, …'),
    path: z.string().min(1).describe('The absolute path.'),
    source: z
      .string()
      .min(1)
      .describe('Where the location came from: default, env:<NAME>, or config.'),
  })
  .strict()
  .describe('One storage location.');
export type ConfigPathRow = z.infer<typeof ConfigPathRow>;

/** `yantra config path --json`. */
export const ConfigPathResult = envelope(
  'config.path',
  { rows: z.array(ConfigPathRow).describe('Every storage location, in display order.') },
  'The `yantra config path --json` document.',
);
export type ConfigPathResult = z.infer<typeof ConfigPathResult>;

/** `yantra config list --json`. */
export const ConfigListResult = envelope(
  'config.list',
  {
    config: z
      .record(z.unknown())
      .describe('config.yaml, validated, with credential references shown as references.'),
  },
  'The `yantra config list --json` document.',
);
export type ConfigListResult = z.infer<typeof ConfigListResult>;

/** `yantra config get <key> --json`. */
export const ConfigGetResult = envelope(
  'config.get',
  {
    key: z.string().min(1).describe('The dotted key that was read.'),
    value: z.unknown().describe('Its value: a scalar, a list or a nested block.'),
  },
  'The `yantra config get --json` document.',
);
export type ConfigGetResult = z.infer<typeof ConfigGetResult>;

/** `yantra config validate --json` (an invalid file exits 1 instead). */
export const ConfigValidateResult = envelope(
  'config.validate',
  {
    valid: z.literal(true).describe('Always true: an invalid config.yaml exits 1.'),
    path: z.string().min(1).describe('The config.yaml that was validated.'),
  },
  'The `yantra config validate --json` document.',
);
export type ConfigValidateResult = z.infer<typeof ConfigValidateResult>;

// ---------------------------------------------------------------- model

/** One registered model in `yantra model list --json`. */
export const ModelListRow = z
  .object({
    provider: z.string().min(1).describe('The model provider, e.g. anthropic or ollama.'),
    id: z.string().min(1).describe('The model id at that provider.'),
    input: z.array(z.string()).describe('Input kinds the model accepts: text, image.'),
    credential: z
      .enum(['env', 'keychain', 'absent'])
      .describe('Where its credential was found: env, keychain, or absent.'),
    default: z.boolean().describe('Whether profile.yaml selects it as the default.'),
  })
  .strict()
  .describe('One registered model.');
export type ModelListRow = z.infer<typeof ModelListRow>;

/** `yantra model list --json`. */
export const ModelListResult = envelope(
  'model.list',
  { rows: z.array(ModelListRow).describe('Every registered model, in config order.') },
  'The `yantra model list --json` document.',
);
export type ModelListResult = z.infer<typeof ModelListResult>;

// ---------------------------------------------------------------- sites

/** One ranked domain. */
export const SiteRankRow = z
  .object({
    domain: z.string().min(1).describe('The hostname.'),
    rank: z.number().describe('Its current rank.'),
    positiveSignals: z.number().int().nonnegative().describe('Signals that raised the rank.'),
    negativeSignals: z.number().int().nonnegative().describe('Signals that lowered the rank.'),
    origin: z.enum(['auto', 'user']).describe('auto: learned from runs; user: added by you.'),
    firstSeenAt: isoTime.describe('When the domain was first ranked.'),
    lastSignalAt: isoTime.describe('When its rank last changed.'),
  })
  .strict()
  .describe('One ranked domain.');
export type SiteRankRow = z.infer<typeof SiteRankRow>;

/** `yantra sites list --json`. */
export const SitesListResult = envelope(
  'sites',
  { rows: z.array(SiteRankRow).describe('Every ranked domain.') },
  'The `yantra sites list --json` document.',
);
export type SitesListResult = z.infer<typeof SitesListResult>;

// ---------------------------------------------------------------- browser

/** `yantra browser list --json`. Sub-objects are pinned by their leading fields. */
export const BrowserListResult = envelope(
  'browser_list',
  {
    selection: z
      .object({
        source: z.string().min(1).describe('auto, managed or system.'),
        executablePath: z.string().nullable().describe('A configured custom executable, or null.'),
        origin: z.string().min(1).describe('Why this selection applies: default, config, …'),
      })
      .strict()
      .describe('The configured selection.'),
    effective: z
      .object({
        status: z.enum(['resolved', 'unavailable']).describe('Whether a browser resolved.'),
      })
      .passthrough()
      .describe('The browser Yantra would launch, or why none resolves.'),
    managed: z.record(z.unknown()).describe('The Yantra-managed build, or its absence.'),
  },
  'The `yantra browser list --json` document.',
).passthrough();
export type BrowserListResult = z.infer<typeof BrowserListResult>;

// ---------------------------------------------------------------- templates

/** One saved template in `yantra template list --json`. */
export const TemplateListRow = z
  .object({
    name: z.string().min(1).describe('The saved template name.'),
    tags: z.array(z.string()).describe('Its tags.'),
    description: z.string().nullable().describe('Its description, or null.'),
    slotCount: z.number().int().nonnegative().describe('How many slots it declares.'),
    modified: isoTime.describe('When the file last changed.'),
    path: z.string().min(1).describe('The template file.'),
  })
  .strict()
  .describe('One saved template.');
export type TemplateListRow = z.infer<typeof TemplateListRow>;

/** `yantra template list --json`. */
export const TemplateListResult = envelope(
  'template_list',
  {
    tag: z.string().nullable().describe('The --tag filter, or null.'),
    items: z.array(TemplateListRow).describe('The saved templates that match.'),
  },
  'The `yantra template list --json` document.',
);
export type TemplateListResult = z.infer<typeof TemplateListResult>;

/** One slot of a template. */
export const TemplateSlotRow = z
  .object({
    key: z.string().min(1).describe('The slot key.'),
    kind: z.string().min(1).describe('The slot kind.'),
    heading: z.string().describe('The heading path, joined with " > ".'),
    constraints: z.unknown().describe('The slot constraints.'),
    columns: z.unknown().describe('Table columns, for a table slot.'),
    guidance: z.string().nullable().describe('Author guidance, or null.'),
  })
  .strict()
  .describe('One template slot.');
export type TemplateSlotRow = z.infer<typeof TemplateSlotRow>;

/** `yantra template show <name> --json`. */
export const TemplateShowResult = envelope(
  'template_show',
  {
    name: z.string().min(1).describe('The saved template name.'),
    path: z.string().min(1).describe('The template file.'),
    markdown: z.string().describe('The template text, verbatim.'),
    template: z
      .object({
        name: z.string().describe('Template name from its frontmatter.'),
        description: z.string().nullable().describe('Its description.'),
        guidance: z.string().nullable().describe('Its overall guidance.'),
        tags: z.array(z.string()).describe('Its tags.'),
        hash: z.string().describe('Content hash.'),
        slotCount: z.number().int().nonnegative().describe('How many slots it declares.'),
      })
      .strict()
      .describe('The parsed template metadata.'),
    slots: z.array(TemplateSlotRow).describe('Its slots, in document order.'),
  },
  'The `yantra template show --json` document.',
);
export type TemplateShowResult = z.infer<typeof TemplateShowResult>;

// ---------------------------------------------------------------- workflows, show

/** `yantra show <target> --json`: a saved workflow or a run. */
export const ShowResult = envelope(
  'show',
  {
    item: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('workflow'),
            name: z.string().min(1).describe('The workflow name.'),
            yaml: z.string().describe('The workflow, as indented JSON text.'),
            locatorCounts: z
              .record(z.number().int().nonnegative())
              .describe('Locator strategies used, by kind.'),
          })
          .strict()
          .describe('A saved workflow.'),
        z
          .object({
            kind: z.literal('run'),
            runId: z.string().min(1).describe('The run id.'),
            manifest: z.record(z.unknown()).describe('The run manifest.'),
            events: z.array(z.record(z.unknown())).describe('The most recent events.'),
          })
          .strict()
          .describe('A run.'),
      ])
      .describe('What was shown.'),
  },
  'The `yantra show --json` document.',
);
export type ShowResult = z.infer<typeof ShowResult>;

// ---------------------------------------------------------------- schedules, usage, daemon

/** One registered schedule in `yantra schedules --json`. */
export const ScheduleRow = z
  .object({
    id: z.string().min(1).describe('The schedule id (`yantra unschedule <id>`).'),
    workflowName: z.string().min(1).describe('The workflow it runs.'),
    cronExpr: z.string().min(1).describe('Its cron expression.'),
    params: z.record(z.string()).describe('Workflow parameters.'),
    notifyTarget: z.string().min(1).describe('Where a fire is reported: desktop, file or none.'),
    onConfirm: z.string().min(1).describe('Confirmation policy.'),
    enabled: z.boolean().describe('Whether the daemon fires it.'),
    createdAt: isoTime.describe('When it was registered.'),
    lastFireAt: z.string().nullable().describe('The last fire, or null.'),
    nextFireAt: z.string().nullable().describe('The next fire, or null when disabled.'),
    pendingConfirmation: z.boolean().describe('A fire is waiting for your confirmation.'),
  })
  .passthrough()
  .describe('One registered schedule.');
export type ScheduleRow = z.infer<typeof ScheduleRow>;

/** `yantra schedules --json`: a bare array, as the CLI prints it. */
export const SchedulesResult = z
  .array(ScheduleRow)
  .describe('The `yantra schedules --json` document: a bare array of schedules.');
export type SchedulesResult = z.infer<typeof SchedulesResult>;

/** One day × provider row of `yantra usage --json`. */
export const UsageRow = z
  .object({
    day: z.string().min(1).describe('The day, YYYY-MM-DD.'),
    provider: z.string().nullable().describe('The model provider, or null for deterministic runs.'),
    taskCount: z.number().int().nonnegative().describe('Tasks that day.'),
    totalCostUsd: z.number().nonnegative().describe('Their metered cost in USD.'),
  })
  .passthrough()
  .describe('Task volume and cost for one day and provider.');
export type UsageRow = z.infer<typeof UsageRow>;

/** `yantra usage --json`. */
export const UsageResult = envelope(
  'usage',
  {
    rows: z.array(UsageRow).describe('One row per day and provider.'),
    totals: z
      .object({
        taskCount: z.number().int().nonnegative(),
        totalCostUsd: z.number().nonnegative(),
      })
      .strict()
      .describe('Sums over every row.'),
    note: z.string().optional().describe('Why the result is empty, when it is.'),
  },
  'The `yantra usage --json` document.',
);
export type UsageResult = z.infer<typeof UsageResult>;

/** `yantra daemon status --json`: the status object, unwrapped. */
export const DaemonStatusResult = z
  .object({
    running: z.boolean().describe('Whether the scheduler daemon is running.'),
    pid: z.number().int().positive().nullable().describe('Its process id, or null.'),
    schedulesLoaded: z.number().int().nonnegative().describe('Schedules it has loaded.'),
    nextFires: z
      .array(
        z
          .object({ id: z.string().min(1), nextFireAt: z.string().nullable() })
          .strict()
          .describe('A schedule and its next fire.'),
      )
      .describe('Upcoming fires.'),
    pendingConfirmations: z
      .number()
      .int()
      .nonnegative()
      .describe('Parked fires waiting for your confirmation.'),
  })
  .strict()
  .describe('The `yantra daemon status --json` document.');
export type DaemonStatusResult = z.infer<typeof DaemonStatusResult>;

// ---------------------------------------------------------------- preferences

/** One effective preference: value and where it came from. */
export const PreferenceRow = z
  .object({
    key: z.string().min(1).describe('The dotted preference key.'),
    value: z.unknown().describe('Its value.'),
    source: z.string().min(1).describe('Where the value came from.'),
  })
  .passthrough()
  .describe('One effective preference.');
export type PreferenceRow = z.infer<typeof PreferenceRow>;

/** `yantra profile --json`. */
export const ProfileResult = envelope(
  'profile',
  {
    profilePath: z.string().min(1).describe('The profile.yaml path.'),
    preferences: z.array(PreferenceRow).describe('Every effective preference, by key.'),
  },
  'The `yantra profile --json` document.',
);
export type ProfileResult = z.infer<typeof ProfileResult>;

/**
 * `yantra prefs <action> --json`: `list` prints `rows`, `get` prints `key`
 * and `record`, and the mutating actions print a `status`.
 */
export const PrefsResult = z
  .object({
    schemaVersion: version,
    kind: z.literal('prefs').describe('Always `prefs`.'),
    rows: z.array(PreferenceRow).optional().describe('`prefs list`: every stored preference.'),
    key: z.string().optional().describe('The key read or changed.'),
    record: z.unknown().optional().describe('`prefs get`: the stored record.'),
    status: z.string().optional().describe('A mutating action: what happened.'),
    value: z.unknown().optional().describe('`prefs set`: the value written.'),
  })
  .passthrough()
  .describe('The `yantra prefs --json` document.');
export type PrefsResult = z.infer<typeof PrefsResult>;

/** Every schema in this module, by the name the registry's `json.schema` uses. */
export const CLI_READ_OUTPUT_SCHEMAS = {
  ConfigPathResult,
  ConfigListResult,
  ConfigGetResult,
  ConfigValidateResult,
  ModelListResult,
  SitesListResult,
  BrowserListResult,
  TemplateListResult,
  TemplateShowResult,
  ShowResult,
  SchedulesResult,
  UsageResult,
  DaemonStatusResult,
  ProfileResult,
  PrefsResult,
} as const;
