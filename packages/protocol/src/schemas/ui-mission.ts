import { z } from 'zod';

import { isAbsoluteCwd } from '../commands/invocation.js';
import { JsonValue } from '../commands/schema.js';

import { SettingSourceSchema } from './execution-receipt.js';

/**
 * The Mission screen's host reads (FEAT-067): what the composer shows next to
 * each option, and whether a model provider is ready for `do`.
 *
 * Values are never secret: a secret-input option is left out entirely, and a
 * secret-reference option (`--auth-secret`) carries the reference name, never
 * what it resolves to. Sources use the execution receipt's vocabulary, so
 * what the composer shows is what the run records.
 */

const commandPath = z
  .array(z.string().regex(/^[a-z][a-z0-9-]*$/u))
  .min(1)
  .max(4)
  .describe('Command path, e.g. ["research"].');

/** `read.effective_options` params. */
export const EffectiveOptionsParams = z
  .object({
    path: commandPath,
    argv: z
      .array(z.string().max(8_192))
      .max(256)
      .describe('The tokens after the path, exactly as the composer would submit them.'),
    cwd: z
      .string()
      .refine(isAbsoluteCwd, 'cwd must be absolute')
      .describe('The absolute working directory the run would start in.'),
  })
  .strict()
  .describe('Resolve every option the command would use, read-only.');
export type EffectiveOptionsParams = z.infer<typeof EffectiveOptionsParams>;

/** One option's effective value and where it came from. */
export const EffectiveOptionView = z
  .object({
    option: z
      .string()
      .min(1)
      .describe('The registry option attribute, e.g. `model` (`llm` for `--no-llm`).'),
    flag: z.string().startsWith('--').describe('The long flag, e.g. `--model`.'),
    value: JsonValue.nullable().describe('The effective value; never a secret.'),
    source: SettingSourceSchema.describe(
      'Where the value came from: the flag, an environment variable (by name), a preference or config key, or the default.',
    ),
  })
  .strict()
  .describe('One option as the command would resolve it now.');
export type EffectiveOptionView = z.infer<typeof EffectiveOptionView>;

/** `read.effective_options` result. */
export const EffectiveOptions = z
  .object({
    path: commandPath,
    mode: z
      .enum(['llm', 'deterministic'])
      .describe(
        'The mode these options resolve to (`--no-llm` or `LLM_PROVIDER=none` mean deterministic).',
      ),
    options: z
      .array(EffectiveOptionView)
      .describe(
        'Every option that applies in this mode, in help order: no secret input, no known dead control.',
      ),
  })
  .strict()
  .describe('Effective option values for one composed command.');
export type EffectiveOptions = z.infer<typeof EffectiveOptions>;

/** A command a person runs to fix something (shown as a CLI twin). */
export const FixCommand = z
  .object({
    label: z.string().min(1).describe('What the fix does, in words.'),
    path: commandPath,
    argv: z.array(z.string()).describe('The tokens after the path.'),
  })
  .strict()
  .describe('A real registry command that fixes the problem.');
export type FixCommand = z.infer<typeof FixCommand>;

/** `read.provider_readiness` result. */
export const ProviderReadiness = z
  .object({
    ready: z.boolean().describe('Whether an agentic run could open a provider session now.'),
    provider: z.string().describe('The provider an agentic run would use.'),
    model: z.string().describe('The model an agentic run would use.'),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe('Why it is not ready, in words; absent when ready.'),
    fix: FixCommand.optional().describe('The command that fixes it, when there is one.'),
  })
  .strict()
  .describe('Whether `do` can run, and how to fix it when not.');
export type ProviderReadiness = z.infer<typeof ProviderReadiness>;
