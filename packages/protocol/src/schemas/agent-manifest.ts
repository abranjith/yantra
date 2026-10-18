import { z } from 'zod';

const RelativeSessionFile = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes('..'),
    'Session file must be a relative path contained by the run directory.',
  )
  .describe('Relative path from the run directory to the provider session JSONL.');

const BudgetCount = z.number().int().nonnegative();

/**
 * The budgets a run actually ran under, after flags, environment, and profile
 * resolved. A null limit means the run was not bounded on that axis.
 */
export const AgentRunBudgets = z
  .object({
    wall_clock_ms: BudgetCount.nullable().describe('Run wall-clock budget, or null if unbounded.'),
    soft_wall_clock_fraction: z
      .number()
      .min(0)
      .max(1)
      .describe('Fraction of the wall clock after which exploration winds down.'),
    max_provider_tokens: BudgetCount.nullable().describe(
      'Provider-token budget, or null if unbounded.',
    ),
    max_navigations: BudgetCount.describe('Browser navigation budget.'),
    max_hosts: BudgetCount.describe('Distinct-host budget.'),
    tool_retries: BudgetCount.describe('Consecutive failed tool calls the breaker tolerates.'),
  })
  .strict()
  .describe('Effective budgets for one agentic run.');

export type AgentRunBudgets = z.infer<typeof AgentRunBudgets>;

/** Stable provider-session metadata persisted inside a run manifest. */
export const AgentManifestSection = z
  .object({
    adapter: z.literal('pi-coding-agent').describe('Agent adapter used for this run.'),
    sdk_version: z.string().min(1).describe('Installed provider SDK version resolved at runtime.'),
    provider: z.string().min(1).describe('Effective model provider identifier.'),
    model: z.string().min(1).describe('Effective provider-scoped model identifier.'),
    thinking: z.string().min(1).describe('Effective model thinking or reasoning level.'),
    auth_source: z
      .enum(['managed', 'runtime-key', 'environment'])
      .describe('Credential source used to open the session; never credential material.'),
    session_id: z.string().min(1).describe('Provider-assigned session identifier.'),
    session_file: RelativeSessionFile,
    // Every version ever shipped stays listed so previously persisted run
    // manifests keep validating (run-artifact compatibility).
    prompt_version: z
      .enum([
        'agent-v1',
        'agent-v2',
        'agent-v3',
        'agent-v4',
        'agent-v5',
        'agent-v6',
        'agent-v7',
        'agent-v8',
        'agent-v9',
        'agent-v10',
        'agent-v11',
        'agent-v12',
      ])
      .describe('Version of the authoritative agent prompt.'),
    prompt_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the exact system prompt.'),
    tool_catalog_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the canonical tool catalog serialization.'),
    yantra_version: z
      .string()
      .min(1)
      .optional()
      .describe('Version of the Yantra agent package that ran; absent on older manifests.'),
    budgets: AgentRunBudgets.optional().describe(
      'Effective run budgets; absent on older manifests.',
    ),
  })
  .strict()
  .describe('Stable agent metadata embedded in manifest.json for one run-local session.');

export type AgentManifestSection = z.infer<typeof AgentManifestSection>;
