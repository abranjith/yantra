/** `doctor`: read by default, a run with `--agent-smoke`. */

import { exit, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

export const doctor = leaf({
  id: 'doctor',
  description: 'Diagnose the local environment for Yantra',
  registration: 'added',
  options: [
    { group: 'agent-model' },
    { group: 'no-llm' },
    jsonOption('emit JSON output'),
    option(
      '--refresh',
      're-probe the environment instead of reusing the cached probe (agent and configuration checks always run fresh)',
      { default: false },
    ),
    option('--agent-smoke', 'run a live agent provider smoke test instead of the offline checks', {
      default: false,
    }),
  ],
  execution: {
    default: 'read',
    rules: [{ when: { option: '--agent-smoke', present: true }, class: 'run' }],
  },
  effect: 'external',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('every check passed or only warned'),
    exit.validation(`${PARSE_ERRORS}, or --agent-smoke on the deterministic path`),
    exit.environment(
      'an environment check failed, the agent smoke failed, or agent credentials are unavailable',
    ),
  ],
  json: { flag: '--json', shape: 'envelope', schema: null },
});
