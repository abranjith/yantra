import { resolve } from 'node:path';

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
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext, CommandResult, ExitCode } from '../context/command-context.js';
import { resourceOptions } from '../context/resource-options.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { fromAction } from '../registry/handler.js';
import type { HandlerArgs } from '../registry/handler.js';
import { makeStderrLogger } from '../runtime.js';
import { openScheduleStore } from '../schedule-store.js';

import { withValidatedRegistration, withScheduleRegistryLock } from './schedule-registration.js';

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
  return createRegisteredCommand('schedule', scheduleHandlers());
}

/** Handlers for `schedule`, bound by registry id; each is its former commander action, unchanged. */
export function scheduleHandlers(context: CommandContext = createTerminalContext()) {
  return {
    schedule: fromAction(async (workflowName: string, options: ScheduleOptions) => {
      const logger = makeStderrLogger(options.debug === true, context.output.stderr);

      // `--on-confirm` accepts only the safe value — reject anything else at
      // parse time (plan §6: "no auto-confirm code path to misconfigure").
      if (options.onConfirm !== undefined && options.onConfirm !== 'pause-and-notify') {
        context.output.stderr.write(
          `Invalid --on-confirm "${options.onConfirm}": only "pause-and-notify" is accepted (scheduled runs never auto-confirm).\n`,
        );
        return { exitCode: 1 as ExitCode };
      }

      const notify = options.notify ?? 'desktop';
      if (!NOTIFY_TARGETS.includes(notify as NotifyTarget)) {
        context.output.stderr.write(
          `Invalid --notify "${notify}": expected one of ${NOTIFY_TARGETS.join(' | ')}.\n`,
        );
        return { exitCode: 1 as ExitCode };
      }

      let params: ParamArg[];
      try {
        params = parseParamArgs(options.params);
      } catch (err) {
        context.output.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return { exitCode: 1 as ExitCode };
      }

      const workflowStore = new FileWorkflowStore(workflowsRoot());
      const validated = await withValidatedRegistration(
        {
          workflowName,
          cronExpr: options.cron!,
          params,
          ...(options.paramsFile !== undefined
            ? { paramsFile: resolve(context.cwd, options.paramsFile) }
            : {}),
          notifyTarget: notify as NotifyTarget,
        },
        workflowStore,
        async (registration) => {
          const handle = await openScheduleStore(logger);
          if (handle === null) return null;
          try {
            return await handle.store.register(registration);
          } finally {
            handle.close();
          }
        },
        { ...resourceOptions(context, 'schedule'), logger },
      ).catch((error: unknown) => {
        throw error;
      });

      if (!validated.ok) {
        context.output.stderr.write(`${validated.reason}\n`);
        return { exitCode: 1 as ExitCode };
      }

      const registered = validated.value;
      if (registered === null) {
        context.output.stderr.write(
          'Error: the local index (index.db) is unavailable — cannot register a schedule.\n',
        );
        return { exitCode: 3 as ExitCode };
      }

      if (!registered.isOk) {
        context.output.stderr.write(`Error: ${registered.error.message}\n`);
        return { exitCode: 2 as ExitCode };
      }
      const schedule = registered.value;

      if (options.json === true) {
        context.output.json(schedule, { indent: 2 });
      } else {
        context.output.stdout.write(
          `✓ Scheduled "${schedule.workflowName}" (${schedule.id})\n` +
            `  cron:   ${schedule.cronExpr}\n` +
            `  next:   ${schedule.nextFireAt ?? '—'}\n` +
            `  notify: ${schedule.notifyTarget}\n` +
            `\nStart the daemon to run it: yantra daemon start\n`,
        );
      }
      return { exitCode: 0 as ExitCode };
    }),
  };
}

/** `yantra schedules [--json]` — list registered schedules with next fires (registry entry `schedules`). */
export async function schedulesHandler(
  _args: HandlerArgs,
  options: SchedulesOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<CommandResult> {
  const logger = makeStderrLogger(options.debug === true, context.output.stderr);

  const handle = await openScheduleStore(logger);
  if (handle === null) {
    if (options.json === true) {
      context.output.json([]);
      return { exitCode: 0 as ExitCode };
    }
    context.output.stderr.write('note: the local index is unavailable — no schedules to show.\n');
    return { exitCode: 0 as ExitCode };
  }

  try {
    const listed = await handle.store.list();
    if (!listed.isOk) {
      context.output.stderr.write(`Error: ${listed.error.message}\n`);
      return { exitCode: 2 as ExitCode };
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
      context.output.json(rows, { indent: 2 });
      return { exitCode: 0 as ExitCode };
    }

    if (rows.length === 0) {
      context.output.stdout.write(
        'No schedules registered. Use `yantra schedule <workflow> --cron`.\n',
      );
      return { exitCode: 0 as ExitCode };
    }

    context.output.stdout.write(renderSchedulesTable(rows));
    return { exitCode: 0 as ExitCode };
  } finally {
    handle.close();
  }
}

/** `yantra unschedule <id>` — remove a schedule by id. */
export function makeUnscheduleCommand(): Command {
  return createRegisteredCommand('unschedule', unscheduleHandlers());
}

/** Handlers for `unschedule`, bound by registry id; each is its former commander action, unchanged. */
export function unscheduleHandlers(context: CommandContext = createTerminalContext()) {
  return {
    unschedule: fromAction(async (id: string, options: UnscheduleOptions) => {
      const logger = makeStderrLogger(options.debug === true, context.output.stderr);

      const handle = await openScheduleStore(logger);
      if (handle === null) {
        context.output.stderr.write(
          'Error: the local index is unavailable — cannot remove a schedule.\n',
        );
        return { exitCode: 3 as ExitCode };
      }

      try {
        const removed = await withScheduleRegistryLock(() => handle.store.remove(id), {
          ...resourceOptions(context, 'unschedule'),
          logger,
        }).catch((error: unknown) => {
          throw error;
        });
        if (!removed.isOk) {
          context.output.stderr.write(`Error: ${removed.error.message}\n`);
          return { exitCode: 2 as ExitCode };
        }
        if (!removed.value) {
          const message = `No schedule found with id "${id}".`;
          if (options.json === true) {
            context.output.json({ removed: false, id }, { indent: 2 });
          } else {
            context.output.stderr.write(`${message}\n`);
          }
          return { exitCode: 1 as ExitCode };
        }

        if (options.json === true) {
          context.output.json({ removed: true, id }, { indent: 2 });
        } else {
          context.output.stdout.write(`✓ Removed schedule ${id}\n`);
        }
        return { exitCode: 0 as ExitCode };
      } finally {
        handle.close();
      }
    }),
  };
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
