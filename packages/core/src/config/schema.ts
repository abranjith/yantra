import { isAbsolute, join, win32 } from 'node:path';

import { z } from 'zod';

import { yantraHome } from '../browser/paths.js';

import { parseConfigRef, type ConfigRef } from './refs.js';

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isAbsolute(value) || win32.isAbsolute(value), 'expected an absolute path');

const configRefSchema = z
  .string()
  .superRefine((value, context) => {
    const parsed = parseConfigRef(value);
    if (!parsed.isOk) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${parsed.error}; literal credentials are forbidden - use yantra secret set`,
      });
    }
  })
  .transform((value): ConfigRef => {
    const parsed = parseConfigRef(value);
    if (!parsed.isOk) throw new Error(parsed.error);
    return parsed.value;
  });

const hostedProviders = new Set([
  'anthropic',
  'openai',
  'google',
  'groq',
  'mistral',
  'openrouter',
  'xai',
]);

export const modelConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    provider: z
      .string()
      .trim()
      .min(1)
      .transform((value) => value.toLowerCase()),
    base_url: z.string().url().nullable().default(null),
    api_key: configRefSchema.nullable().default(null),
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .default(['text']),
  })
  .strict()
  .superRefine((model, context) => {
    if (!hostedProviders.has(model.provider) && !model.base_url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base_url'],
        message: `base_url is required for provider "${model.provider}"`,
      });
    }
  });

const providerCredentialSchema = z
  .object({ api_key: configRefSchema.nullable().default(null) })
  .strict()
  .default({});

const rateLimitSchema = z
  .object({
    tokens_per_second: z.number().positive().default(1),
    burst: z.number().positive().default(2),
  })
  .strict();

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase();
}

function nested(a: string, b: string): boolean {
  const left = normalizedPath(a);
  const right = normalizedPath(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function insideDefaultData(path: string): boolean {
  const defaultData = normalizedPath(join(yantraHome(), 'data'));
  return normalizedPath(path).startsWith(`${defaultData}/`);
}

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    paths: z
      .object({
        data_dir: absolutePath.nullable().default(null),
        cache_dir: absolutePath.nullable().default(null),
      })
      .strict()
      .default({}),
    models: z.array(modelConfigSchema).default([]),
    search: z
      .object({
        provider: z.enum(['auto', 'google', 'duckduckgo', 'brave', 'tavily']).default('auto'),
        fallback_chain: z
          .array(z.enum(['google', 'duckduckgo', 'brave', 'tavily']))
          .transform((values) => [...new Set(values)])
          .default(['tavily', 'brave', 'duckduckgo']),
        fetch_top: z.number().int().min(1).max(5).default(3),
        tavily: providerCredentialSchema,
        brave: providerCredentialSchema,
      })
      .strict()
      .default({}),
    ethics: z
      .object({
        robots_enabled: z.boolean().default(false),
        user_agent: z.string().min(1).default('YantraBot/0.1 (+https://yantra.dev)'),
        rate_limit: z
          .object({
            default: rateLimitSchema.default({}),
            overrides: z.record(z.string(), rateLimitSchema).default({}),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    retention: z
      .object({
        runs_days: z.number().int().nonnegative().default(30),
        corrupt_index_keep: z.number().int().nonnegative().default(3),
      })
      .strict()
      .default({}),
    agent: z
      .object({ pi_auth_path: absolutePath.nullable().default(null) })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.paths.data_dir &&
      config.paths.cache_dir &&
      nested(config.paths.data_dir, config.paths.cache_dir)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paths'],
        message: 'data_dir and cache_dir must not contain one another',
      });
    }
    for (const [key, path] of Object.entries(config.paths)) {
      if (path && insideDefaultData(path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['paths', key],
          message: 'storage directories must not be nested inside the default data directory',
        });
      }
    }
    const seen = new Set<string>();
    for (const [index, model] of config.models.entries()) {
      const key = `${model.provider}\u0000${model.id}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index],
          message: `duplicate model (${model.provider}, ${model.id})`,
        });
      }
      seen.add(key);
    }
  });

export type YantraConfig = z.infer<typeof configSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const KNOWN_CONFIG_KEYS = [
  'version',
  'paths.data_dir',
  'paths.cache_dir',
  'models',
  'search.provider',
  'search.fallback_chain',
  'search.fetch_top',
  'search.tavily.api_key',
  'search.brave.api_key',
  'ethics.robots_enabled',
  'ethics.user_agent',
  'ethics.rate_limit.default.tokens_per_second',
  'ethics.rate_limit.default.burst',
  'ethics.rate_limit.overrides',
  'retention.runs_days',
  'retention.corrupt_index_keep',
  'agent.pi_auth_path',
] as const;
