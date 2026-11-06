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

const PENDING = 'registry entry and handler extraction scheduled for a later FEAT-062 task';

export const UNMIGRATED_COMMANDS: readonly UnmigratedCommand[] = [
  { path: 'ask', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'research', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'do', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'run', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'confirm', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'config', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'secret', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'resume', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'schedule', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'unschedule', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'daemon', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'lint', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'model', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'open', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'prefs', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'sites', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'template', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'doctor', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'init', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
  { path: 'browser', since: '2026-11-05', reason: PENDING, owner: 'FEAT-070' },
];
