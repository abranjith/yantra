/**
 * `format(parse(argv))` round-trips for every command in every shell where
 * the format is available: tokenizing the formatted line with a reference
 * model of the shell and re-parsing gives the same parse.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  LEAF_COMMAND_IDS,
  formatInvocation,
  parseInvocation,
  type LeafEntry,
  type ParsedInvocation,
} from '../../src/commands/index.js';

import { adversarialValue, leafArgv } from './argv-arbitraries.js';
import { TOKENIZERS, type ShellName } from './shell-tokenizers.js';

const RUNS_PER_LEAF = 100;
const SHELLS: readonly ShellName[] = ['posix', 'powershell', 'cmd'];
const CWD = '/work';
/** Characters cmd cannot carry: line breaks, `"`, `%` and other control characters. */
// eslint-disable-next-line no-control-regex
const CMD_UNREPRESENTABLE = /[\r\n"%\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const leaves = COMMAND_REGISTRY.commands.filter(
  (entry): entry is LeafEntry => entry.kind === 'leaf',
);

function comparable(parsed: ParsedInvocation) {
  return {
    path: parsed.invocation.path,
    arguments: parsed.arguments,
    options: parsed.options,
    explicit: [...parsed.explicit].sort(),
  };
}

const hasSecret = (entry: LeafEntry): boolean =>
  entry.arguments.some((argument) => argument.input.kind === 'secret-input');

const covered = new Set<string>();

describe('@no-llm format(parse(argv)) round-trips', () => {
  it.each(leaves.map((leaf) => [leaf.id, leaf] as const))('%s', (_id, entry) => {
    fc.assert(
      fc.property(
        leafArgv(entry, COMMAND_REGISTRY.option_groups, {
          nearValid: false,
          value: adversarialValue(),
        }),
        fc.constantFrom(...SHELLS),
        fc.constantFrom<string | string[]>('yantra', ['node', '/abs path/bin.js']),
        (argv, shell, program) => {
          const original = parseInvocation(argv, { cwd: CWD });
          fc.pre(original.isOk);
          if (!original.isOk) return;
          const result = formatInvocation(original.value.invocation, shell, { program });

          if (!result.ok) {
            if (result.reason === 'secret_input') {
              expect(hasSecret(entry)).toBe(true);
              return;
            }
            expect(shell).toBe('cmd');
            const tokens = [...original.value.invocation.path, ...original.value.invocation.argv];
            expect(tokens.some((token) => CMD_UNREPRESENTABLE.test(token))).toBe(true);
            return;
          }

          const programTokens = typeof program === 'string' ? 1 : program.length;
          const reparsed = parseInvocation(TOKENIZERS[shell](result.text).slice(programTokens), {
            cwd: CWD,
          });
          expect(reparsed.isOk).toBe(true);
          if (!reparsed.isOk) return;
          expect(comparable(reparsed.value)).toEqual(comparable(original.value));
          covered.add(entry.id);
        },
      ),
      { numRuns: RUNS_PER_LEAF },
    );
  });

  it('covered every leaf with at least one successful round trip', () => {
    expect(LEAF_COMMAND_IDS.filter((id) => !covered.has(id))).toEqual([]);
    expect(covered.size).toBe(leaves.length);
  });
});
