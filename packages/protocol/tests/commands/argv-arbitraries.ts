/**
 * fast-check arbitraries that generate argv for one registry leaf: valid
 * invocations with shuffled option placement and every option form, plus
 * near-valid ones (missing values, unknown flags, extra positionals, `--`,
 * help and version tokens). Shared by the CLI parse-parity suite and the
 * protocol format round-trip suite.
 */

import fc from 'fast-check';

import {
  expandOptions,
  type ExpandedOption,
  type LeafEntry,
  type OptionGroup,
} from '../../src/commands/index.js';

/** Characters that stress every shell's quoting rules. */
export const ADVERSARIAL_CHARS = [
  'a',
  'Z',
  '0',
  ' ',
  '\t',
  '"',
  "'",
  '`',
  '$',
  '%',
  '^',
  '!',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
  ';',
  ',',
  '=',
  '*',
  '?',
  '#',
  '~',
  '{',
  '}',
  '[',
  ']',
  '\\',
  '/',
  '@',
  ':',
  '.',
  '-',
  '+',
  'é',
  '東',
  '\n',
];

export interface ArgvOptions {
  /** Add near-valid mutations (missing values, unknown flags, …). */
  readonly nearValid: boolean;
  /** Value alphabet; defaults to a small safe set plus tricky literals. */
  readonly value?: fc.Arbitrary<string>;
}

const defaultValue = fc.oneof(
  { weight: 4, arbitrary: fc.stringMatching(/^[a-z0-9=._]{1,6}$/) },
  {
    weight: 1,
    arbitrary: fc.constantFrom('x y', '-5', '', 'é東', '-x', '--', '--help', 'a=b=c'),
  },
);

/** A string drawn from {@link ADVERSARIAL_CHARS}. */
export const adversarialValue = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.string({ unit: fc.constantFrom(...ADVERSARIAL_CHARS), minLength: 0, maxLength: 8 }),
    fc.stringMatching(/^[a-z0-9]{1,5}$/),
  );

function optionUnit(
  option: ExpandedOption,
  value: fc.Arbitrary<string>,
  nearValid: boolean,
): fc.Arbitrary<string[]> {
  const flag =
    option.short === undefined
      ? fc.constant(option.long)
      : fc.constantFrom(option.long, option.short);
  if (option.value === 'none') return flag.map((f) => [f]);
  const choices =
    option.input.kind === 'enum' && option.input.enforced_by === 'parser'
      ? option.input.choices
      : null;
  const optionValue =
    choices === null
      ? value
      : nearValid
        ? fc.oneof(
            { weight: 5, arbitrary: fc.constantFrom(...choices) },
            { weight: 1, arbitrary: value },
          )
        : fc.constantFrom(...choices);
  const forms: fc.Arbitrary<string[]>[] = [
    fc.tuple(flag, optionValue).map(([f, v]) => [f, v]),
    optionValue.map((v) => [`${option.long}=${v}`]),
  ];
  if (option.short !== undefined) {
    forms.push(optionValue.filter((v) => v.length > 0).map((v) => [`${option.short!}${v}`]));
  }
  if (option.variadic) {
    forms.push(fc.tuple(optionValue, optionValue).map(([a, b]) => [option.long, a, b]));
  }
  return fc.oneof(...forms);
}

/**
 * Argv (after the program name) for one leaf.
 *
 * Valid mode keeps the grammar unambiguous: variadic options are always
 * followed by another option or the end, value-taking options never get a
 * value commander would read as an option, and positional values never start
 * with `-` unless they follow `--`.
 */
export function leafArgv(
  entry: LeafEntry,
  groups: readonly OptionGroup[],
  { nearValid, value = defaultValue }: ArgvOptions,
): fc.Arbitrary<string[]> {
  const options = expandOptions(entry, groups);
  const pathArb =
    entry.aliases.length === 0
      ? fc.constant([...entry.path])
      : fc
          .constantFrom(...[entry.path.at(-1)!, ...entry.aliases])
          .map((last) => [...entry.path.slice(0, -1), last]);

  const safeValue = nearValid ? value : value.filter((v) => !v.startsWith('-'));
  const positional = entry.arguments.map((argument) =>
    argument.required
      ? safeValue.map((v) => [v])
      : fc.option(
          safeValue.map((v) => [v]),
          { nil: undefined },
        ),
  );
  const optionUnits = options.map((option) =>
    fc.tuple(
      option.mandatory && !nearValid ? fc.constant(true) : fc.boolean(),
      optionUnit(option, safeValue, nearValid),
      fc.nat(entry.arguments.length),
    ),
  );

  return fc
    .tuple(
      pathArb,
      fc.tuple(...(positional as fc.Arbitrary<string[] | undefined>[])),
      fc.tuple(...optionUnits),
      fc.boolean(),
      nearValid
        ? fc.array(
            fc.constantFrom(
              ['--zz-unknown'],
              ['extra'],
              ['-h'],
              ['--help'],
              ['-V'],
              ['--'],
              [options[0]?.long ?? '--zz'],
              ['help'],
            ),
            { maxLength: 2 },
          )
        : fc.constant([] as string[][]),
      fc.nat(),
    )
    .map(([path, positionals, units, dashDash, noise, seed]) => {
      // Positional values in order, stopping at the first omitted optional one.
      const values: string[] = [];
      for (const item of positionals) {
        if (item === undefined) break;
        values.push(...item);
      }
      const placed = units
        .map(([include, tokens, slot], index) => ({ include, tokens, slot, index }))
        .filter((unit) => unit.include);
      // In valid mode a variadic option (`-p a b`) keeps consuming operands, so
      // it goes after every positional.
      const swallows = (tokens: readonly string[]): boolean =>
        !nearValid &&
        options.some((o) => o.variadic && (tokens[0] === o.long || tokens[0] === o.short));
      const tail = placed.filter((unit) => swallows(unit.tokens)).flatMap((unit) => unit.tokens);
      const interleaved = placed.filter((unit) => !swallows(unit.tokens));

      let argv: string[];
      if (!nearValid && dashDash && values.length > 0) {
        // Every option first, then `--`, then the positionals.
        argv = [...interleaved.flatMap((unit) => unit.tokens), ...tail, '--', ...values];
      } else {
        argv = [];
        for (let slot = 0; slot <= values.length; slot += 1) {
          for (const unit of interleaved.filter((u) => u.slot === slot)) argv.push(...unit.tokens);
          if (slot < values.length) argv.push(values[slot]!);
        }
        argv.push(...tail);
      }
      for (const [offset, tokens] of noise.entries()) {
        const at = (seed + offset * 7) % (argv.length + 1);
        argv.splice(at, 0, ...tokens);
      }
      return [...path, ...argv];
    });
}
