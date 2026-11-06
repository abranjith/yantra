import { z } from 'zod';

/**
 * Command registry schemas (FEAT-062).
 *
 * Every Yantra command and subcommand is described as data: its path,
 * arguments, options, execution class, effect, danger, option relations, exit
 * codes and `--json` result. The CLI generates its commander tree from this
 * data, and every app surface (composer, palette, generated forms, host read
 * RPCs, worker adapters) reads the same registry, so the app cannot drift from
 * the CLI.
 *
 * Help-visible strings (descriptions, flags) are the CLI's own text, moved
 * verbatim. Field names use the protocol's snake_case.
 *
 * This module is browser-safe: it imports no Node built-ins.
 */

/** A JSON value: what an option default or a condition comparison may hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(JsonValue),
      z.record(JsonValue),
    ]),
  )
  .describe('Any JSON value.');

/** The plan §6 execution classes. */
export const ExecutionClass = z
  .enum(['run', 'read', 'mutate', 'exclusive', 'in-process-secure', 'adapter', 'exemption'])
  .describe(
    'How a surface executes the command: run (detached worker, slot counted), read (host, in-process), mutate (short-lived worker under locks), exclusive (blocks run starts), in-process-secure (value never in argv), adapter (an app-side adapter replaces the generated surface), exemption (a reviewed decision keeps it terminal-only).',
  );
export type ExecutionClass = z.infer<typeof ExecutionClass>;

/** Named, reusable option sets, spelled identically wherever they are registered. */
export const OptionGroupId = z
  .enum(['agent-model', 'agent-budget', 'agent-turn', 'no-llm', 'screenshots', 'browser-selection'])
  .describe('Identifier of a named, reusable option group.');
export type OptionGroupId = z.infer<typeof OptionGroupId>;

/** App-side adapters that replace a generated surface for an exceptional command. */
export const AdapterId = z
  .enum([
    'init-onboarding',
    'open-result-view',
    'config-edit-yaml',
    'daemon-control',
    'confirm-inbox',
  ])
  .describe('Identifier of an app-side adapter for an exceptional command.');
export type AdapterId = z.infer<typeof AdapterId>;

const simpleInput = <TKind extends string>(kind: TKind, description: string) =>
  z
    .object({ kind: z.literal(kind) })
    .strict()
    .describe(description);

/** Form-metadata input kind: how a generated form collects one value. */
export const InputKind = z
  .discriminatedUnion('kind', [
    simpleInput('text', 'Free text.'),
    simpleInput('bool', 'A switch (a flag that takes no value).'),
    simpleInput('duration', 'A duration such as 90s, 15m or bare milliseconds.'),
    simpleInput('workflow-ref', 'The name of a saved workflow.'),
    simpleInput('template-ref', 'A saved report template name, tag or Markdown path.'),
    simpleInput('run-ref', 'A run id.'),
    simpleInput(
      'secret-input',
      'A secret value. Never rendered into a copyable command or written to argv.',
    ),
    z
      .object({
        kind: z.literal('enum'),
        choices: z.array(z.string().min(1)).nonempty().describe('Allowed values, in help order.'),
        enforced_by: z
          .enum(['parser', 'handler'])
          .describe(
            'parser: commander rejects other values and help lists the choices; handler: the command validates the value itself.',
          ),
      })
      .strict()
      .describe('One of a closed set of values.'),
    z
      .object({
        kind: z.literal('number'),
        integer: z.boolean().describe('Whether only integers are meaningful.'),
        min: z.number().optional().describe('Smallest meaningful value, when bounded.'),
      })
      .strict()
      .describe('A number, passed as text on the command line.'),
    z
      .object({
        kind: z.literal('path'),
        target: z.enum(['file', 'dir']).describe('Whether the path names a file or a directory.'),
      })
      .strict()
      .describe('A filesystem path.'),
  ])
  .describe('How a generated form collects this value.');
export type InputKind = z.infer<typeof InputKind>;

/** One step of an option's effective-value resolution. */
export const PrecedenceStep = z
  .discriminatedUnion('source', [
    z
      .object({ source: z.literal('flag') })
      .strict()
      .describe('The flag as typed.'),
    z
      .object({
        source: z.literal('env'),
        name: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .describe('Environment variable name only.'),
        equals: z
          .string()
          .optional()
          .describe('When present, the step applies only when the variable equals this value.'),
      })
      .strict()
      .describe('An environment variable.'),
    z
      .object({
        source: z.literal('preference'),
        key: z.string().min(1).describe('Dotted key in profile.yaml.'),
      })
      .strict()
      .describe('A stored preference (profile.yaml).'),
    z
      .object({
        source: z.literal('config'),
        key: z.string().min(1).describe('Dotted key in config.yaml.'),
      })
      .strict()
      .describe('Installation configuration (config.yaml).'),
    z
      .object({
        source: z.literal('default'),
        value: JsonValue.describe('The pinned effective default.'),
        note: z.string().optional().describe('Why the default is what it is, when not obvious.'),
      })
      .strict()
      .describe('The pinned default, used when no earlier step supplies a value.'),
  ])
  .describe('One step of the effective-value resolution chain.');
export type PrecedenceStep = z.infer<typeof PrecedenceStep>;

/** A predicate over one parsed invocation. */
export const Condition = z
  .union([
    z
      .object({
        option: z.string().startsWith('--').describe('Long flag of the option.'),
        present: z.literal(true).describe('Holds when the user set the option.'),
      })
      .strict(),
    z
      .object({
        option: z.string().startsWith('--').describe('Long flag of the option.'),
        equals: JsonValue.describe('Holds when the parsed value deep-equals this value.'),
      })
      .strict(),
    z
      .object({
        argument: z.string().min(1).describe('Argument name.'),
        in: z
          .array(z.string())
          .nonempty()
          .describe('Holds when the argument value is one of these.'),
      })
      .strict(),
    z
      .object({
        mode: z
          .enum(['llm', 'deterministic'])
          .describe('Holds when the invocation resolves to this mode.'),
      })
      .strict(),
  ])
  .describe('A predicate over one parsed invocation.');
export type Condition = z.infer<typeof Condition>;

/** Whether a generated form must ask for explicit confirmation. */
export const DangerSpec = z
  .discriminatedUnion('level', [
    z.object({ level: z.literal('none') }).strict(),
    z
      .object({
        level: z.literal('confirm'),
        reason: z.string().min(1).describe('What the user is confirming, in CLI vocabulary.'),
      })
      .strict(),
  ])
  .describe('Whether a generated surface must ask for explicit confirmation first.');
export type DangerSpec = z.infer<typeof DangerSpec>;

/** One option as commander registers it, plus its form metadata. */
export const OptionSpec = z
  .object({
    flags: z
      .string()
      .min(2)
      .describe('The exact commander flags string, e.g. "-p, --params <key=value...>".'),
    long: z.string().startsWith('--').describe('Long flag, e.g. "--params".'),
    short: z
      .string()
      .regex(/^-[A-Za-z0-9]$/)
      .optional()
      .describe('Short flag, e.g. "-p".'),
    attribute: z
      .string()
      .min(1)
      .describe('Commander attribute name ("params"; "llm" for "--no-llm").'),
    value: z
      .enum(['none', 'required', 'optional'])
      .describe('Whether the option takes no value, a required value or an optional value.'),
    variadic: z.boolean().default(false).describe('Whether one occurrence takes several values.'),
    negatable: z.boolean().default(false).describe('Whether this is a "--no-x" negation.'),
    repeatable: z
      .boolean()
      .default(false)
      .describe('Whether repeated occurrences accumulate (the CLI attaches its collect parser).'),
    description: z.string().describe('Help-visible description.'),
    default: JsonValue.optional().describe(
      'Commander parse default that help shows as "(default: …)". Absent means none. The effective default is the last precedence step.',
    ),
    mandatory: z.boolean().default(false).describe('Registered with requiredOption.'),
    input: InputKind,
    precedence: z
      .array(PrecedenceStep)
      .nonempty()
      .optional()
      .describe('How the effective value resolves, in order.'),
    applicability: z
      .array(Condition)
      .nonempty()
      .optional()
      .describe('When the option has an effect; all conditions must hold.'),
    danger: DangerSpec.optional().describe('Option-level danger, e.g. --force.'),
  })
  .strict()
  .describe('One command-line option.');
export type OptionSpec = z.infer<typeof OptionSpec>;
export type OptionSpecInput = z.input<typeof OptionSpec>;

/** A named option set, expanded in place wherever a command references it. */
export const OptionGroup = z
  .object({
    id: OptionGroupId,
    options: z.array(OptionSpec).nonempty().describe('Options in registration order.'),
  })
  .strict()
  .describe('A named, reusable option set.');
export type OptionGroup = z.infer<typeof OptionGroup>;
export type OptionGroupInput = z.input<typeof OptionGroup>;

/** A group reference or an inline option, in registration (help) order. */
export const OptionRef = z
  .union([z.object({ group: OptionGroupId }).strict(), OptionSpec])
  .describe('A reference to an option group, or an inline option.');
export type OptionRef = z.infer<typeof OptionRef>;

/** One positional argument. */
export const ArgumentSpec = z
  .object({
    name: z.string().min(1).describe('Argument name as commander shows it, e.g. "run-id".'),
    description: z.string().describe('Help-visible description (may be empty).'),
    required: z.boolean().describe('"<x>" when true, "[x]" when false.'),
    variadic: z.boolean().default(false).describe('Whether it collects all remaining operands.'),
    default: JsonValue.optional().describe(
      'Commander parse default for an optional argument, shown in help.',
    ),
    input: InputKind,
  })
  .strict()
  .describe('One positional argument.');
export type ArgumentSpec = z.infer<typeof ArgumentSpec>;

/** A conditional override of the default execution class. */
export const ExecutionRule = z
  .object({
    when: Condition,
    class: ExecutionClass,
  })
  .strict()
  .describe('When `when` holds, the command executes as `class`. The first matching rule wins.');
export type ExecutionRule = z.infer<typeof ExecutionRule>;

/** How the command executes, possibly depending on its options and arguments. */
export const ExecutionSpec = z
  .object({
    default: ExecutionClass.describe('Class when no rule matches.'),
    rules: z.array(ExecutionRule).default([]).describe('Ordered rules; the first match wins.'),
    adapter: z
      .object({
        id: AdapterId,
        executes_as: ExecutionClass.optional().describe(
          'The class the adapter itself executes the command as.',
        ),
        note: z.string().min(1).describe('What the adapter does instead of a generated form.'),
      })
      .strict()
      .optional()
      .describe('Required when any reachable class is adapter.'),
    exemption: z
      .object({
        decision: z.string().min(1).describe('The plan decision that grants the exemption.'),
        reason: z.string().min(1).describe('Why the command stays terminal-only.'),
      })
      .strict()
      .optional()
      .describe('Required when any reachable class is exemption.'),
  })
  .strict()
  .describe('The execution class, possibly option-dependent.');
export type ExecutionSpec = z.infer<typeof ExecutionSpec>;

/** An option relation the CLI already enforces. */
export const Relation = z
  .object({
    kind: z.enum(['requires', 'conflicts']),
    option: z.string().startsWith('--').describe('Long flag the relation constrains.'),
    with: z
      .array(z.string().startsWith('--'))
      .nonempty()
      .describe('Long flags it requires or conflicts with.'),
    note: z.string().optional().describe('The precise enforced rule, when narrower than the kind.'),
  })
  .strict()
  .describe('A requires/conflicts relation the CLI already enforces.');
export type Relation = z.infer<typeof Relation>;

/** The documented exit codes (memory → Error Handling). */
export const ExitCode = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ExitCode = z.infer<typeof ExitCode>;

/** One exit code the command can return. */
export const ExitCodeSpec = z
  .object({
    code: ExitCode.describe('0 success, 1 validation, 2 execution, 3 environment, 4 user handoff.'),
    meaning: z.string().min(1).describe('What this code means for this command.'),
  })
  .strict()
  .describe('One exit code the command can return.');
export type ExitCodeSpec = z.infer<typeof ExitCodeSpec>;

/** What `--json` emits. */
export const JsonResultSpec = z
  .object({
    flag: z.literal('--json').nullable().describe('"--json" when the command registers it.'),
    shape: z
      .enum(['document', 'ndjson', 'envelope', 'none'])
      .describe('One JSON document, newline-delimited events, an envelope, or no JSON output.'),
    schema: z
      .string()
      .nullable()
      .describe('Exported protocol schema name, or null when not yet described.'),
  })
  .strict()
  .describe('What the command emits under --json.');
export type JsonResultSpec = z.infer<typeof JsonResultSpec>;

const commonEntryFields = {
  id: z.string().min(1).describe('Dotted path, e.g. "config.data-dir". Equals path.join(".").'),
  path: z
    .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
    .nonempty()
    .describe('Command tokens from the root.'),
  description: z.string().describe('Help-visible description.'),
  help_after: z.string().optional().describe("Text added with addHelpText('after', …)."),
  registration: z
    .enum(['subcommand', 'added'])
    .describe(
      'subcommand: created with parent.command() and inherits parent settings such as showHelpAfterError; added: new Command() plus addCommand, which does not.',
    ),
};

/** A command with subcommands and no action. */
export const GroupEntry = z
  .object({ kind: z.literal('group'), ...commonEntryFields })
  .strict()
  .describe('A command with subcommands and no action.');
export type GroupEntry = z.infer<typeof GroupEntry>;

/** An executable command. */
export const LeafEntry = z
  .object({
    kind: z.literal('leaf'),
    ...commonEntryFields,
    aliases: z.array(z.string().min(1)).default([]).describe('Alternative names, e.g. "discover".'),
    arguments: z.array(ArgumentSpec).default([]).describe('Ordered positionals.'),
    options: z.array(OptionRef).default([]).describe('Ordered options and group references.'),
    execution: ExecutionSpec,
    effect: z
      .enum(['none', 'local', 'external'])
      .describe(
        'Maximum effect: none (read only), local (writes Yantra-owned state), external (contacts websites, providers or download servers).',
      ),
    danger: DangerSpec,
    relations: z.array(Relation).default([]),
    exit_codes: z.array(ExitCodeSpec).nonempty().describe('Exit codes the command can return.'),
    json: JsonResultSpec,
  })
  .strict()
  .describe('An executable command.');
export type LeafEntry = z.infer<typeof LeafEntry>;

/** One registry entry. */
export const CommandEntry = z
  .discriminatedUnion('kind', [GroupEntry, LeafEntry])
  .describe('A group or an executable leaf.');
export type CommandEntry = z.infer<typeof CommandEntry>;
export type CommandEntryInput = z.input<typeof CommandEntry>;

/** The whole command surface, in root-help order. */
export const CommandRegistry = z
  .object({
    registry_version: z.literal(1).describe('Bumped on any breaking shape change.'),
    program: z
      .object({
        name: z.literal('yantra'),
        description: z.string().min(1).describe('Root help description.'),
      })
      .strict()
      .describe('Root command metadata. The version string stays runtime-derived in the CLI.'),
    option_groups: z.array(OptionGroup).describe('Named option groups.'),
    commands: z
      .array(CommandEntry)
      .describe('Entries in root-help order: each group is followed by its subcommands.'),
  })
  .strict()
  .describe('The complete Yantra command surface.');
export type CommandRegistry = z.infer<typeof CommandRegistry>;
export type CommandRegistryInput = z.input<typeof CommandRegistry>;
