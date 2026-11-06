/**
 * Top-level command families still registered by hand rather than generated
 * from the command registry. The list may only shrink: FEAT-062 migrates
 * families command by command, and FEAT-070's parity work empties it.
 */

/** One family still built by its legacy factory. */
export interface UnmigratedCommand {
  /** Top-level command name. */
  readonly path: string;
  /** ISO date the entry was recorded. */
  readonly since: string;
  /** Why it is not generated yet. */
  readonly reason: string;
  readonly owner: 'FEAT-070';
}

/**
 * Empty since FEAT-062 TASK-007: every family is generated from the registry.
 * A family may be added back only with a dated entry and a reason, and the
 * list may only shrink again.
 */
export const UNMIGRATED_COMMANDS: readonly UnmigratedCommand[] = [];
