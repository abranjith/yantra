import type { ResourceLockOptions } from '@yantra/core';

import type { CommandContext } from './command-context.js';

/** Display metadata contains the command path only, never user arguments. */
export function resourceOptions(context: CommandContext, command: string): ResourceLockOptions {
  return {
    logger: context.logger,
    owner: {
      pid: context.processes.pid,
      command: `yantra ${command}`,
      started_at: new Date().toISOString(),
      surface: context.surface,
    },
  };
}
