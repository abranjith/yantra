import { ResourceBusyError } from '@yantra/core';
import { CommanderError } from 'commander';

import { CLI_JSON_SCHEMA_VERSION } from './render/json.js';

/** Interim writer adapter; executeCommand owns this mapping after TASK-006. */
export function throwIfResourceBusy(
  error: unknown,
  kind: string,
  json: boolean,
  output: {
    readonly stdout: Pick<NodeJS.WritableStream, 'write'>;
    readonly stderr: Pick<NodeJS.WritableStream, 'write'>;
  },
): void {
  if (!(error instanceof ResourceBusyError)) return;
  if (json) {
    output.stdout.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind, status: 'busy', resource: error.resource, holder: error.holder })}\n`,
    );
  } else output.stderr.write(`${error.message} ${error.remediation}\n`);
  throw new CommanderError(3, 'yantra.resource.busy', error.message);
}
