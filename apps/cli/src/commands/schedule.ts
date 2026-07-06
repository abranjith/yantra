/**
 * `yantra schedule` / `yantra schedules` / `yantra unschedule` — register,
 * list, and remove recurring unattended workflow runs (FEAT-021 TASK-001).
 *
 *   yantra schedule <workflow> --cron "<expr>" [--params k=v] [--params-file f]
 *                              [--notify desktop|file|none]
 *                              [--on-confirm pause-and-notify]
 *   yantra schedules [--json]
 *   yantra unschedule <id> [--json]
 *
 * `--on-confirm` accepts only `pause-and-notify` — there is no auto-confirm
 * value to misconfigure (plan §6). Registration validates the workflow exists +
 * lints clean, the cron parses, and the params are safe (no credential shapes).
 *
 * @example
 *   yantra schedule bank-statement --cron "0 8 * * 1" --notify desktop
 *   yantra schedules --json
 *   yantra unschedule 01J8ZK...
 */

import { workflowsRoot, FileWorkflowStore, nextFireIso, type NotifyTarget } from '@yantra/core';
import type { ParamArg } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { makeStderrLogger } from '../runtime.js';
import { openScheduleStore } from '../schedule-store.js';

import { validateRegistration } from './schedule-registration.js';

const NOTIFY_TARGETS: readonly NotifyTarget[] = ['desktop', 'file', 'none'];

interface ScheduleOptions {
  readonly cron?: string;
  readonly params?: string[];
  readonly paramsFile?: string;
  readonly notify?: string;
  readonly onConfirm?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
}

interface SchedulesOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

interface UnscheduleOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parses `key=value` CLI pairs into ParamArgs (registration re-validates). */
function parseParamArgs(raw: readonly string[] | undefined): ParamArg[] {
  const out: ParamArg[] = [];
  for (const entry of raw ?? []) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid --params "${entry}": expected key=value`);
    }
    out.push({ key: entry.slice(0, eqIdx), rawValue: entry.slice(eqIdx + 1) });
  }
  return out;
}

/** `yantra schedule <workflow> --cron "<expr>"` — register a recurring run. */
export function makeScheduleCommand(): Command {
  const cmd = new Command('schedule');

  cmd
    .description('Register a recurring unattended run of a saved workflow')
    .argument('<workflow-name>', 'Name of the saved workflow to schedule')
    .requiredOption('--cron <expr>', 'Cron expression (e.g. "0 8 * * 1")')
    .option(
      '-p, --params <key=value...>',
      'Workflow parameter (repeatable)',
      collect,
      [] as string[],
    )
    .option('--params-file <path>', 'YAML/JSON file of parameter key-value pairs')
    .option('--notify <target>', 'Notification sink: desktop | file | none', 'desktop')
    .option(
      '--on-confirm <policy>',
      'Confirmation policy — only "pause-and-notify" is accepted',
      'pause-and-notify',
    )
    .option('--json', 'Emit JSON summary to stdout', false)
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (workflowName: string, options: ScheduleOptions) => {
      const logger = makeStderrLogger(options.debug === true);

      // `--on-confirm` accepts only the safe value — reject anything else at
      // parse time (plan §6: "no auto-confirm code path to misconfigure").
      if (options.onConfirm !== undefined && options.onConfirm !== 'pause-and-notify') {
        process.stderr.write(
          `Invalid --on-confirm "${options.onConfirm}": only "pause-and-notify" is accepted (scheduled runs never auto-confirm).\n`,
        );
        process.exit(1);
      }

      const notify = options.notify ?? 'desktop';
      if (!NOTIFY_TARGETS.includes(notify as NotifyTarget)) {
        process.stderr.write(
          `Invalid --notify "${notify}": expected one of ${NOTIFY_TARGETS.join(' | ')}.\n`,
        );
        process.exit(1);
      }

      let params: ParamArg[];
      try {
        params = parseParamArgs(options.params);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }

      const workflowStore = new FileWorkflowStore(workflowsRoot());
      const validated = await validateRegistration(
        {
          workflowName,
          cronExpr: options.cron!,
          params,
          ...(options.paramsFile !== undefined ? { paramsFile: options.paramsFile } : {}),
          notifyTarget: notify as NotifyTarget,
        },
        workflowStore,
      );

      if (!validated.ok) {
        process.stderr.write(`${validated.reason}\n`);
        process.exit(1);
        return;
      }

      const handle = await openScheduleStore(logger);
      if (handle === null) {
        process.stderr.write(
          'Error: the local index (index.db) is unavailable — cannot register a schedule.\n',
        );
        process.exit(3);
        return;
      }

      try {
        const registered = await handle.store.register(validated.registration);
        if (!registered.isOk) {
          process.stderr.write(`Error: ${registered.error.message}\n`);
          process.exit(2);
          return;
        }
        const schedule = registered.value;

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`);
        } else {
          process.stdout.write(
            `✓ Scheduled "${schedule.workflowName}" (${schedule.id})\n` +
              `  cron:   ${schedule.cronExpr}\n` +
              `  next:   ${schedule.nextFireAt ?? '—'}\n` +
              `  notify: ${schedule.notifyTarget}\n` +
              `\nStart the daemon to run it: yantra daemon start\n`,
          );
        }
        process.exit(0);
      } finally {
        handle.close();
      }
    });

  return cmd;
}

/** `yantra schedules [--json]` — list registered schedules with next fires. */
export function makeSchedulesCommand(): Command {
  const cmd = new Command('schedules');

  cmd
    .description('List registered schedules')
    .option('--json', 'Emit JSON array to stdout', false)
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (options: SchedulesOptions) => {
      const logger = makeStderrLogger(options.debug === true);

      const handle = await openScheduleStore(logger);
      if (handle === null) {
        if (options.json === true) {
          process.stdout.write('[]\n');
          process.exit(0);
        }
        process.stderr.write('note: the local index is unavailable — no schedules to show.\n');
        process.exit(0);
        return;
      }

      try {
        const listed = await handle.store.list();
        if (!listed.isOk) {
          process.stderr.write(`Error: ${listed.error.message}\n`);
          process.exit(2);
          return;
        }

        // Recompute the authoritative next fire for display (the stored
        // next_fire_at is an advisory cache).
        const now = new Date();
        const rows = listed.value.map((s) => ({
          ...s,
          nextFireAt: s.enabled ? nextFireIso(s.cronExpr, now) : null,
          pendingConfirmation: s.lastStatus === 'pending-confirmation',
        }));

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          process.exit(0);
          return;
        }

        if (rows.length === 0) {
          process.stdout.write(
            'No schedules registered. Use `yantra schedule <workflow> --cron`.\n',
          );
          process.exit(0);
          return;
        }

        process.stdout.write(renderSchedulesTable(rows));
        process.exit(0);
      } finally {
        handle.close();
      }
    });

  return cmd;
}

/** `yantra unschedule <id>` — remove a schedule by id. */
export function makeUnscheduleCommand(): Command {
  const cmd = new Command('unschedule');

  cmd
    .description('Remove a registered schedule')
    .argument('<id>', 'Schedule id (from `yantra schedules`)')
    .option('--json', 'Emit JSON summary to stdout', false)
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (id: string, options: UnscheduleOptions) => {
      const logger = makeStderrLogger(options.debug === true);

      const handle = await openScheduleStore(logger);
      if (handle === null) {
        process.stderr.write('Error: the local index is unavailable — cannot remove a schedule.\n');
        process.exit(3);
        return;
      }

      try {
        const removed = await handle.store.remove(id);
        if (!removed.isOk) {
          process.stderr.write(`Error: ${removed.error.message}\n`);
          process.exit(2);
          return;
        }
        if (!removed.value) {
          const message = `No schedule found with id "${id}".`;
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ removed: false, id }, null, 2)}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exit(1);
          return;
        }

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ removed: true, id }, null, 2)}\n`);
        } else {
          process.stdout.write(`✓ Removed schedule ${id}\n`);
        }
        process.exit(0);
      } finally {
        handle.close();
      }
    });

  return cmd;
}

interface ScheduleDisplayRow {
  readonly id: string;
  readonly workflowName: string;
  readonly cronExpr: string;
  readonly enabled: boolean;
  readonly nextFireAt: string | null;
  readonly notifyTarget: NotifyTarget;
  readonly lastStatus: string | null;
  readonly pendingConfirmation: boolean;
}

/** Renders a compact plain-text table (no decoration deps in this command). */
function renderSchedulesTable(rows: readonly ScheduleDisplayRow[]): string {
  const lines: string[] = [];
  lines.push(
    'ID                          WORKFLOW          CRON            NEXT FIRE                 STATUS',
  );
  for (const row of rows) {
    const status = row.pendingConfirmation
      ? 'pending-confirmation'
      : !row.enabled
        ? 'disabled'
        : (row.lastStatus ?? 'idle');
    lines.push(
      [
        row.id.padEnd(27),
        row.workflowName.slice(0, 17).padEnd(17),
        row.cronExpr.slice(0, 15).padEnd(15),
        (row.nextFireAt ?? '—').padEnd(25),
        status,
      ].join(' '),
    );
  }
  return lines.join('\n') + '\n';
}
