import { z } from 'zod';

export const UsageProvider = z
  .enum(['anthropic', 'ollama', 'openai'])
  .describe('Provider used for the model call.');

export type UsageProvider = z.infer<typeof UsageProvider>;

export const UsageCall = z
  .object({
    step_id: z.string().nullable().describe('Owning step id, null for plan-generation calls.'),
    model: z.string().min(1).describe('Model identifier.'),
    provider: UsageProvider.describe('Provider identifier.'),
    input_tokens: z.number().int().nonnegative().describe('Input token count.'),
    output_tokens: z.number().int().nonnegative().describe('Output token count.'),
    cost_estimate_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Nullable estimated cost in USD.'),
    latency_ms: z.number().int().nonnegative().describe('Call latency in milliseconds.'),
    at: z.string().datetime().describe('ISO-8601 UTC timestamp.'),
  })
  .describe('Single LLM usage call record.');

export type UsageCall = z.infer<typeof UsageCall>;

export const AgentUsageTotals = z
  .object({
    turns: z.number().int().nonnegative().describe('Completed provider turns.'),
    input_tokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Agent input tokens, or null when the provider does not report them.'),
    output_tokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Agent output tokens, or null when the provider does not report them.'),
    cost_usd: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Agent cost in USD, or null when the provider does not report it.'),
  })
  .strict()
  .describe('Aggregated provider usage for an agentic run.');

export type AgentUsageTotals = z.infer<typeof AgentUsageTotals>;

export const UsageLedger = z
  .object({
    run_id: z.string().min(1).describe('Owning run id.'),
    calls: z.array(UsageCall).describe('Chronological call records.'),
    totals: z
      .object({
        input_tokens: z.number().int().nonnegative().describe('Total input tokens.'),
        output_tokens: z.number().int().nonnegative().describe('Total output tokens.'),
        cost_estimate_usd: z.number().nonnegative().nullable().describe('Total estimated cost.'),
        call_count: z.number().int().nonnegative().describe('Total call count.'),
      })
      .describe('Aggregated usage totals.'),
    agent: AgentUsageTotals.optional().describe(
      'Agentic-session totals when this run used the live agent runtime.',
    ),
  })
  .describe('Usage ledger persisted per run.');

export type UsageLedger = z.infer<typeof UsageLedger>;

export interface UsageTotalsWarning {
  path: string;
  message: string;
}

export const validateUsageLedgerTotals = (ledger: UsageLedger): UsageTotalsWarning[] => {
  const input_tokens = ledger.calls.reduce((sum, call) => sum + call.input_tokens, 0);
  const output_tokens = ledger.calls.reduce((sum, call) => sum + call.output_tokens, 0);
  const call_count = ledger.calls.length;

  const cost_values = ledger.calls
    .map((call) => call.cost_estimate_usd)
    .filter((value): value is number => value !== null);

  const cost_estimate_usd =
    cost_values.length === ledger.calls.length
      ? cost_values.reduce((sum, value) => sum + value, 0)
      : null;

  const warnings: UsageTotalsWarning[] = [];

  if (ledger.totals.input_tokens !== input_tokens) {
    warnings.push({
      path: '/totals/input_tokens',
      message: `Expected ${input_tokens} from calls, found ${ledger.totals.input_tokens}.`,
    });
  }

  if (ledger.totals.output_tokens !== output_tokens) {
    warnings.push({
      path: '/totals/output_tokens',
      message: `Expected ${output_tokens} from calls, found ${ledger.totals.output_tokens}.`,
    });
  }

  if (ledger.totals.call_count !== call_count) {
    warnings.push({
      path: '/totals/call_count',
      message: `Expected ${call_count} from calls, found ${ledger.totals.call_count}.`,
    });
  }

  if (ledger.totals.cost_estimate_usd !== cost_estimate_usd) {
    warnings.push({
      path: '/totals/cost_estimate_usd',
      message: `Expected ${String(cost_estimate_usd)} from calls, found ${String(
        ledger.totals.cost_estimate_usd,
      )}.`,
    });
  }

  return warnings;
};
