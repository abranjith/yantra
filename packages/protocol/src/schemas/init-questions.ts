import { z } from 'zod';

import { CREDENTIAL_MAX_BYTES } from './credentials.js';

/**
 * Shared `init` question catalog and onboarding RPC schemas (FEAT-071 TASK-003).
 *
 * This catalog is pure data in `@yantra/protocol` so both the terminal wizard
 * and the app onboarding flow render the exact same questions, order, choices,
 * literal defaults, and conditional visibility (`when`).
 */

/** Closed set of `init` question IDs in presentation order. */
export const INIT_QUESTION_IDS = [
  'provider',
  'credential_source',
  'credential_env_name',
  'credential_secret',
  'model_id',
  'ollama_base_url',
  'search_key_provider',
  'search_key_secret',
  'data_dir',
  'context_location',
  'context_city',
] as const;

export const InitQuestionId = z
  .enum(INIT_QUESTION_IDS)
  .describe('Unique identifier for an onboarding/init question.');
export type InitQuestionId = z.infer<typeof InitQuestionId>;

export const InitQuestionKind = z
  .enum(['select', 'text', 'secret', 'confirm'])
  .describe('Input widget kind for an init question.');
export type InitQuestionKind = z.infer<typeof InitQuestionKind>;

export const InitQuestionSection = z
  .enum(['model', 'search', 'storage', 'context'])
  .describe('Logical onboarding step grouping.');
export type InitQuestionSection = z.infer<typeof InitQuestionSection>;

export const InitAnswerScalar = z.union([z.string(), z.boolean(), z.null()]);
export type InitAnswerScalar = z.infer<typeof InitAnswerScalar>;

export type InitQuestionAnswerMap = Readonly<Partial<Record<InitQuestionId, InitAnswerScalar>>>;

/** Closed discriminated union for conditional question visibility. */
export type InitQuestionWhen =
  | {
      readonly op: 'in';
      readonly question: InitQuestionId;
      readonly values: readonly InitAnswerScalar[];
    }
  | {
      readonly op: 'eq';
      readonly question: InitQuestionId;
      readonly value: InitAnswerScalar;
    }
  | {
      readonly op: 'and';
      readonly conditions: readonly InitQuestionWhen[];
    };

export const InitQuestionWhen: z.ZodType<InitQuestionWhen> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z
      .object({
        op: z.literal('in'),
        question: InitQuestionId,
        values: z.array(InitAnswerScalar).min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal('eq'),
        question: InitQuestionId,
        value: InitAnswerScalar,
      })
      .strict(),
    z
      .object({
        op: z.literal('and'),
        conditions: z.array(InitQuestionWhen).min(1),
      })
      .strict(),
  ]),
);

export const InitQuestionInitialBy = z
  .object({
    question: InitQuestionId,
    map: z.record(z.string(), z.string()),
  })
  .strict()
  .describe('Optional map from an earlier answer value to a literal initial value.');
export type InitQuestionInitialBy = z.infer<typeof InitQuestionInitialBy>;

export const InitQuestion = z
  .object({
    id: InitQuestionId,
    kind: InitQuestionKind,
    message: z.string().min(1),
    choices: z.array(z.string().min(1)).nullable(),
    initial: z.string().nullable(),
    initialBy: InitQuestionInitialBy.optional(),
    optional: z.boolean(),
    when: InitQuestionWhen.nullable(),
    section: InitQuestionSection,
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.kind === 'select' && (!q.choices || q.choices.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['choices'],
        message: 'Select questions must declare non-empty choices.',
      });
    }
    if (q.kind !== 'select' && q.choices !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['choices'],
        message: 'Only select questions may declare choices.',
      });
    }
  })
  .describe('One question descriptor in the shared init catalog.');
export type InitQuestion = z.infer<typeof InitQuestion>;

/** Ordered catalog of every question asked by `yantra init` and app onboarding. */
export const INIT_QUESTIONS: readonly InitQuestion[] = [
  {
    id: 'provider',
    kind: 'select',
    message: 'Model provider',
    choices: ['anthropic', 'ollama', 'none'],
    initial: null,
    optional: false,
    when: null,
    section: 'model',
  },
  {
    id: 'credential_source',
    kind: 'select',
    message: 'Credential source',
    choices: ['environment variable', 'keychain', 'skip'],
    initial: null,
    optional: true,
    when: { op: 'in', question: 'provider', values: ['anthropic', 'ollama'] },
    section: 'model',
  },
  {
    id: 'credential_env_name',
    kind: 'text',
    message: 'Environment variable name',
    choices: null,
    initial: 'ANTHROPIC_API_KEY',
    initialBy: {
      question: 'provider',
      map: { anthropic: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_API_KEY' },
    },
    optional: false,
    when: {
      op: 'and',
      conditions: [
        { op: 'in', question: 'provider', values: ['anthropic', 'ollama'] },
        { op: 'eq', question: 'credential_source', value: 'environment variable' },
      ],
    },
    section: 'model',
  },
  {
    id: 'credential_secret',
    kind: 'secret',
    message: 'Secret value for {provider}.api_key',
    choices: null,
    initial: null,
    optional: true,
    when: {
      op: 'and',
      conditions: [
        { op: 'in', question: 'provider', values: ['anthropic', 'ollama'] },
        { op: 'eq', question: 'credential_source', value: 'keychain' },
      ],
    },
    section: 'model',
  },
  {
    id: 'model_id',
    kind: 'text',
    message: 'Model id',
    choices: null,
    initial: 'claude-opus-4-7',
    initialBy: {
      question: 'provider',
      map: { anthropic: 'claude-opus-4-7', ollama: 'llama3.1:8b' },
    },
    optional: false,
    when: { op: 'in', question: 'provider', values: ['anthropic', 'ollama'] },
    section: 'model',
  },
  {
    id: 'ollama_base_url',
    kind: 'text',
    message: 'Ollama base URL',
    choices: null,
    initial: 'http://localhost:11434',
    optional: false,
    when: { op: 'eq', question: 'provider', value: 'ollama' },
    section: 'model',
  },
  {
    id: 'search_key_provider',
    kind: 'select',
    message: 'Search provider key (optional)',
    choices: ['tavily', 'brave', 'skip'],
    initial: null,
    optional: true,
    when: null,
    section: 'search',
  },
  {
    id: 'search_key_secret',
    kind: 'secret',
    message: 'Secret value for {search_key_provider}.api_key',
    choices: null,
    initial: null,
    optional: true,
    when: { op: 'in', question: 'search_key_provider', values: ['tavily', 'brave'] },
    section: 'search',
  },
  {
    id: 'data_dir',
    kind: 'text',
    message: 'Data directory (blank for ~/.yantra/data)',
    choices: null,
    initial: null,
    optional: true,
    when: null,
    section: 'storage',
  },
  {
    id: 'context_location',
    kind: 'confirm',
    message:
      "Share your location with the agent? Without it, Yantra will ask you to name a location in queries like 'hotels near me' rather than guessing one.",
    choices: null,
    initial: null,
    optional: true,
    when: null,
    section: 'context',
  },
  {
    id: 'context_city',
    kind: 'text',
    message: 'City or area (e.g. Naperville, IL) — leave blank to set later',
    choices: null,
    initial: null,
    optional: true,
    when: { op: 'eq', question: 'context_location', value: true },
    section: 'context',
  },
] as const;

const SECRET_QUESTION_IDS: ReadonlySet<InitQuestionId> = new Set(
  INIT_QUESTIONS.filter((q) => q.kind === 'secret').map((q) => q.id),
);

const VALID_QUESTION_IDS: ReadonlySet<string> = new Set(INIT_QUESTION_IDS);

/** Evaluates a question's `when` condition against earlier answers. */
export function evaluateWhen(question: InitQuestion, answers: InitQuestionAnswerMap): boolean {
  if (!question.when) return true;
  return evaluateWhenCondition(question.when, answers);
}

function evaluateWhenCondition(
  condition: InitQuestionWhen,
  answers: InitQuestionAnswerMap,
): boolean {
  if (condition.op === 'in') {
    const actual = answers[condition.question] ?? null;
    return condition.values.includes(actual);
  }
  if (condition.op === 'eq') {
    const actual = answers[condition.question] ?? null;
    return actual === condition.value;
  }
  return condition.conditions.every((child) => evaluateWhenCondition(child, answers));
}

/** Resolves any `{question_id}` placeholders in a question's prompt message. */
export function resolveQuestionMessage(
  question: InitQuestion,
  answers: InitQuestionAnswerMap,
): string {
  return question.message.replace(/\{([a-z_]+)\}/g, (full, key: string) => {
    if (!VALID_QUESTION_IDS.has(key)) return full;
    const value = answers[key as InitQuestionId];
    return typeof value === 'string' && value.length > 0 ? value : full;
  });
}

/** Resolves the literal initial value for a question given earlier answers. */
export function resolveQuestionInitial(
  question: InitQuestion,
  answers: InitQuestionAnswerMap,
): string | null {
  if (question.initialBy) {
    const dep = answers[question.initialBy.question];
    if (typeof dep === 'string' && dep in question.initialBy.map) {
      return question.initialBy.map[dep] ?? question.initial;
    }
  }
  return question.initial;
}

const SecretValueSchema = z
  .string()
  .min(1, 'Secret value must not be empty.')
  .refine(
    (value) => new TextEncoder().encode(value).length <= CREDENTIAL_MAX_BYTES,
    'Secret value must not exceed 8 KiB.',
  )
  .describe('secret');

/**
 * `onboarding.submit` request payload.
 *
 * Non-secret answers are separated from `secrets` so the loggable `answers`
 * record can never carry a secret-kind question's value.
 */
export const InitAnswersRequest = z
  .object({
    answers: z
      .record(z.string(), InitAnswerScalar)
      .superRefine((record, ctx) => {
        for (const key of Object.keys(record)) {
          if (!VALID_QUESTION_IDS.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `Unknown init question id "${key}".`,
            });
            continue;
          }
          if (SECRET_QUESTION_IDS.has(key as InitQuestionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `Secret question "${key}" must be supplied in secrets, not answers.`,
            });
          }
        }
      })
      .describe('Non-secret onboarding answers keyed by InitQuestion.id.'),
    secrets: z
      .object({
        credential_secret: SecretValueSchema.optional(),
        search_key_secret: SecretValueSchema.optional(),
      })
      .strict()
      .default({})
      .describe('secret'),
    reset: z.boolean().default(false),
    invocation_id: z.string().min(1),
  })
  .strict()
  .describe('Onboarding submission request.');
export type InitAnswersRequest = z.infer<typeof InitAnswersRequest>;

/** `read.onboarding_status` response. */
export const OnboardingStatus = z
  .object({
    config_exists: z.boolean(),
    profile_exists: z.boolean(),
    config_path: z.string().min(1),
    profile_path: z.string().min(1),
    data_dir: z
      .object({
        effective: z.string().min(1),
        source: z.string().min(1),
        configured: z.string().nullable(),
      })
      .strict(),
    keychain_available: z.boolean(),
  })
  .strict()
  .describe('Current onboarding and installation readiness status.');
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

/** `onboarding.submit` success response (never echoes secrets). */
export const OnboardingResult = z
  .object({
    status: z.enum(['written', 'already_initialized']),
    config_path: z.string().min(1),
    profile_path: z.string().min(1),
    profile_written: z.boolean(),
    provider: z.enum(['anthropic', 'ollama', 'none']),
    search_key: z.enum(['skipped', 'stored', 'manual']),
    command: z.string().min(1).optional(),
    location_shared: z.boolean(),
  })
  .strict()
  .describe('Result of an onboarding submission (no secret values).');
export type OnboardingResult = z.infer<typeof OnboardingResult>;

/** Typed error payloads for `onboarding.submit`. */
export const OnboardingError = z.discriminatedUnion('code', [
  z.object({ code: z.literal('missing_answer'), question_id: InitQuestionId }).strict(),
  z
    .object({ code: z.literal('invalid_answer'), question_id: InitQuestionId, reason: z.string() })
    .strict(),
  z.object({ code: z.literal('keychain_unavailable'), remedy: z.string() }).strict(),
  z
    .object({
      code: z.literal('relocation_requires_terminal'),
      steps: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ code: z.literal('busy'), holder: z.string() }).strict(),
  z.object({ code: z.literal('already_initialized') }).strict(),
]);
export type OnboardingError = z.infer<typeof OnboardingError>;
