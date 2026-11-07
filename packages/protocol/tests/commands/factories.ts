/**
 * Small, valid command registries for schema and validation tests. Each test
 * clones one and breaks exactly one rule.
 */

import type { CommandRegistryInput, OptionSpecInput } from '../../src/commands/index.js';

export const jsonOption = (): OptionSpecInput => ({
  flags: '--json',
  long: '--json',
  attribute: 'json',
  value: 'none',
  description: 'emit JSON',
  default: false,
  input: { kind: 'bool' },
});

export const noLlmOption = (): OptionSpecInput => ({
  flags: '--no-llm',
  long: '--no-llm',
  attribute: 'llm',
  value: 'none',
  negatable: true,
  description: 'force the deterministic no-model path',
  input: { kind: 'bool' },
  precedence: [{ source: 'flag' }, { source: 'env', name: 'LLM_PROVIDER', equals: 'none' }],
});

const exitOk = [{ code: 0 as const, meaning: 'success' }];

/** A registry with a group, a doctor-shaped leaf and a prefs-shaped leaf. */
export function minimalRegistry(): CommandRegistryInput {
  return {
    registry_version: 1,
    program: { name: 'yantra', description: 'test program' },
    option_groups: [{ id: 'no-llm', options: [noLlmOption()] }],
    commands: [
      {
        kind: 'group',
        id: 'config',
        path: ['config'],
        description: 'Inspect configuration',
        registration: 'added',
      },
      {
        kind: 'leaf',
        id: 'config.get',
        path: ['config', 'get'],
        description: '',
        registration: 'subcommand',
        arguments: [{ name: 'key', description: '', required: true, input: { kind: 'text' } }],
        options: [jsonOption()],
        execution: { default: 'read' },
        effect: 'none',
        danger: { level: 'none' },
        exit_codes: exitOk,
        json: { flag: '--json', shape: 'document', schema: null },
      },
      {
        kind: 'leaf',
        id: 'doctor',
        path: ['doctor'],
        description: 'Diagnose',
        registration: 'added',
        options: [
          { group: 'no-llm' },
          {
            flags: '--agent-smoke',
            long: '--agent-smoke',
            attribute: 'agentSmoke',
            value: 'none',
            description: 'run a live smoke test',
            default: false,
            input: { kind: 'bool' },
          },
        ],
        execution: {
          default: 'read',
          rules: [{ when: { option: '--agent-smoke', present: true }, class: 'run' }],
        },
        effect: 'external',
        danger: { level: 'none' },
        exit_codes: [...exitOk, { code: 3, meaning: 'environment check failed' }],
        json: { flag: null, shape: 'none', schema: null },
      },
      {
        kind: 'leaf',
        id: 'prefs',
        path: ['prefs'],
        description: 'Manage preferences',
        registration: 'added',
        arguments: [
          {
            name: 'action',
            description: 'get | set | list | approve',
            required: false,
            input: {
              kind: 'enum',
              choices: ['get', 'set', 'list', 'approve'],
              enforced_by: 'handler',
            },
          },
          { name: 'key', description: '', required: false, input: { kind: 'text' } },
        ],
        options: [
          {
            flags: '--forget <key>',
            long: '--forget',
            attribute: 'forget',
            value: 'required',
            description: 'delete a preference value',
            input: { kind: 'text' },
            danger: { level: 'confirm', reason: 'deletes a stored preference' },
          },
        ],
        execution: {
          default: 'read',
          rules: [
            { when: { argument: 'action', in: ['set', 'approve'] }, class: 'mutate' },
            { when: { option: '--forget', present: true }, class: 'mutate' },
          ],
        },
        effect: 'local',
        danger: { level: 'none' },
        exit_codes: exitOk,
        json: { flag: null, shape: 'none', schema: null },
      },
    ],
  };
}

/** A deep, mutable copy for breaking one rule. */
export function cloneRegistry(): Record<string, unknown> & {
  commands: Record<string, unknown>[];
  option_groups: Record<string, unknown>[];
} {
  return structuredClone(minimalRegistry()) as unknown as Record<string, unknown> & {
    commands: Record<string, unknown>[];
    option_groups: Record<string, unknown>[];
  };
}
