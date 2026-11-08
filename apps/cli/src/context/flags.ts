import { readGlobalFlags, type GlobalFlags } from '../global-flags.js';

import type { CommandContext } from './command-context.js';

/** Global rendering policy over already-parsed options and adapter capabilities. */
export function commandFlags(
  context: CommandContext,
  options: {
    readonly json?: boolean;
    readonly debug?: boolean;
    readonly llm?: boolean;
    readonly color?: boolean;
  },
): GlobalFlags {
  return readGlobalFlags({
    argv: [
      ...(options.json ? ['--json'] : []),
      ...(options.debug ? ['--debug'] : []),
      ...(options.llm === false ? ['--no-llm'] : []),
      ...(options.color === false ? ['--no-color'] : []),
    ],
    env: context.settings.env(),
    isTty: context.output.colorCapable,
  });
}
