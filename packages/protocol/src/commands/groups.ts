/**
 * Named option groups, formerly the CLI registrars in `agent-options.ts` and
 * `browser-options.ts`. A group is spelled identically everywhere it is
 * registered, and a command references only the groups it can act on
 * (memory → General: composed named groups, no dead controls).
 *
 * Options keep the registrars' exact flags, descriptions and order.
 * Precedence chains are read from `resolveAgentInvocation`, `noLlmReason` and
 * `resolveBrowserSelectionOverride`; a CLI test checks them against those
 * resolvers.
 */

import { option } from './entries/builders.js';
import type { OptionGroupInput, OptionSpecInput } from './schema.js';

const LLM_ONLY = [{ mode: 'llm' }] as const;
const duration = { kind: 'duration' } as const;

/** Builds the precedence chain shared by every `YANTRA_AGENT_*` option. */
function agentChain(
  env: string,
  preference: string | null,
  fallback: string | number | null,
  note?: string,
): NonNullable<OptionSpecInput['precedence']> {
  return [
    { source: 'flag' },
    { source: 'env', name: env },
    ...(preference === null ? [] : [{ source: 'preference' as const, key: preference }]),
    { source: 'default', value: fallback, ...(note === undefined ? {} : { note }) },
  ];
}

const groups: OptionGroupInput[] = [
  {
    id: 'agent-model',
    options: [
      option('--provider <name>', 'agent model provider', {
        precedence: agentChain('YANTRA_AGENT_PROVIDER', 'agent.provider', 'anthropic'),
        applicability: [...LLM_ONLY],
      }),
      option('--model <id>', 'provider-scoped model id', {
        precedence: agentChain('YANTRA_AGENT_MODEL', 'agent.model', 'claude-haiku-4-5'),
        applicability: [...LLM_ONLY],
      }),
      option('--thinking <level>', 'provider reasoning level', {
        precedence: agentChain(
          'YANTRA_AGENT_THINKING',
          'agent.thinking',
          null,
          "unset: the provider's own default",
        ),
        applicability: [...LLM_ONLY],
      }),
      option('--auth-secret <ref>', 'runtime model-key secret reference', {
        precedence: agentChain(
          'YANTRA_AGENT_AUTH_SECRET',
          null,
          null,
          'unset: managed credentials',
        ),
        applicability: [...LLM_ONLY],
      }),
    ],
  },
  {
    id: 'agent-budget',
    options: [
      option('--max-duration <duration>', 'whole-run wall-clock duration', {
        input: duration,
        precedence: agentChain('YANTRA_AGENT_MAX_DURATION', 'agent.max_duration', '15m'),
        applicability: [...LLM_ONLY],
      }),
      option('--max-tokens <n>', 'cumulative provider token ceiling', {
        input: { kind: 'number', integer: true, min: 1 },
        precedence: agentChain('YANTRA_AGENT_MAX_TOKENS', 'agent.max_tokens', 2_000_000),
        applicability: [...LLM_ONLY],
      }),
      option('--tool-timeout <duration>', 'timeout for one tool call', {
        input: duration,
        precedence: agentChain('YANTRA_AGENT_TOOL_TIMEOUT', 'agent.tool_timeout', '3m'),
        applicability: [...LLM_ONLY],
      }),
      option('--tool-retries <n>', 'retries after an identical tool failure', {
        input: { kind: 'number', integer: true, min: 0 },
        precedence: agentChain('YANTRA_AGENT_TOOL_RETRIES', 'agent.tool_retries', 3),
        applicability: [...LLM_ONLY],
      }),
      option('--confirm-timeout <duration>', 'maximum live consent wait', {
        input: duration,
        precedence: agentChain('YANTRA_AGENT_CONFIRM_TIMEOUT', 'agent.confirm_timeout', '3m'),
        applicability: [...LLM_ONLY],
      }),
    ],
  },
  {
    id: 'agent-turn',
    options: [
      option('--turn-timeout <duration>', 'thinking time allowed in one provider turn', {
        input: duration,
        precedence: agentChain(
          'YANTRA_AGENT_TURN_TIMEOUT',
          'agent.turn_timeout',
          '2m',
          'at least 10s',
        ),
        applicability: [...LLM_ONLY],
      }),
    ],
  },
  {
    id: 'no-llm',
    options: [
      option('--no-llm', 'force the deterministic no-model path', {
        precedence: [{ source: 'flag' }, { source: 'env', name: 'LLM_PROVIDER', equals: 'none' }],
      }),
    ],
  },
  {
    id: 'screenshots',
    options: [
      option('--no-screenshots', 'no screenshots this run (vision assist and saved captures)', {
        precedence: [
          { source: 'flag' },
          { source: 'preference', key: 'context.screenshots' },
          {
            source: 'default',
            value: false,
            note: 'screenshots need an explicit stored grant; the flag only suppresses one run',
          },
        ],
        applicability: [...LLM_ONLY],
      }),
    ],
  },
  {
    id: 'browser-selection',
    options: [
      option(
        '--browser <source>',
        'browser source for this invocation (auto, managed, or system)',
        {
          input: { kind: 'enum', choices: ['auto', 'managed', 'system'], enforced_by: 'handler' },
          precedence: [
            { source: 'flag' },
            { source: 'config', key: 'browser.source' },
            { source: 'default', value: 'auto' },
          ],
        },
      ),
      option('--browser-path <path>', 'absolute path to a Chrome or Chromium executable', {
        input: { kind: 'path', target: 'file' },
        precedence: [
          { source: 'flag' },
          { source: 'config', key: 'browser.executable_path' },
          { source: 'default', value: null, note: 'unset: discover a system browser' },
        ],
      }),
    ],
  },
];

/**
 * The option groups as registry input. `addAgentOptions` corresponds to
 * `agent-model`, `agent-budget`, `no-llm`, `screenshots`, in that order.
 */
export const OPTION_GROUP_INPUTS: readonly OptionGroupInput[] = groups;
