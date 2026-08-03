/**
 * Parsed global flags shared by every Yantra subcommand.
 *
 * Set at process start (in `main`) and threaded into each command's
 * dependency bag. Mutation is forbidden — commands react to flags, they
 * never alter them.
 */

export interface GlobalFlags {
  readonly json: boolean;
  readonly debug: boolean;
  readonly noLlm: boolean;
  readonly configPath: string | null;
  readonly noColor: boolean;
}

/** Why the shared agent resolver selected the deterministic path. */
export type NoLlmReason = 'flag' | 'env';

/**
 * Resolves the single process-wide no-LLM derivation used by every command.
 * Commander stores `--no-llm` as `llm: false`; `LLM_PROVIDER=none` is the
 * environment-level equivalent.
 */
export function noLlmReason(
  options: { readonly llm?: boolean },
  env: NodeJS.ProcessEnv,
): NoLlmReason | null {
  if (options.llm === false) return 'flag';
  return env.LLM_PROVIDER === 'none' ? 'env' : null;
}

/**
 * Builds a {@link GlobalFlags} bag from `process.argv`-style argv plus the
 * runtime environment. Mutually-exclusive flags are *not* enforced here —
 * commander already rejects unknown flags at the parser layer.
 *
 * `--json` is treated as opt-in: any truthy value (`true`, `1`, present) sets
 * it; otherwise the JSON-renderer is bypassed. `NO_COLOR` env honors the
 * convention at https://no-color.org/.
 */
export function readGlobalFlags(args: {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly isTty: boolean;
}): GlobalFlags {
  const argSet = new Set(args.argv);
  const noColorEnv = Object.prototype.hasOwnProperty.call(args.env, 'NO_COLOR');
  const configIdx = args.argv.indexOf('--config');
  const configPath =
    configIdx >= 0 && configIdx + 1 < args.argv.length ? (args.argv[configIdx + 1] ?? null) : null;

  return {
    json: argSet.has('--json'),
    debug: argSet.has('--debug'),
    noLlm: noLlmReason(argSet.has('--no-llm') ? { llm: false } : {}, args.env) !== null,
    noColor: argSet.has('--no-color') || noColorEnv || !args.isTty,
    configPath,
  };
}
