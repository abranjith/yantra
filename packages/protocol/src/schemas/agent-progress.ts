import { z } from 'zod';

import { DeliverableCaptureReason } from './capture-capability.js';

/**
 * Agent progress events (FEAT-063, promoted from `@yantra/agent`).
 *
 * The bounded, render-safe progress the agent runtime reports while a run is
 * live. Each variant's fields are defined **once**, in
 * {@link AGENT_PROGRESS_SHAPES}, and build two unions:
 *
 * - {@link AgentProgressEvent}, discriminated by `type`: the connector type the
 *   agent runtime has always emitted and `do --json` prints verbatim inside its
 *   `agent_progress` lines;
 * - the matching `RunEvent` variants, discriminated by `kind`
 *   (`schemas/run-event.ts`).
 *
 * Field names and key order are exactly today's emission (including the
 * camelCase `durationMs`), because `--json` output must stay byte-identical.
 * Length bounds are the producers' own bounds, copied rather than invented: no
 * new truncation is introduced here.
 */

/** Live progress item label bound, as `ProgressLedger.liveItems` cuts it. */
export const LIVE_ITEM_LABEL_MAX = 60;
/** Progress line bound, as `renderProgressLine` cuts it. */
export const PROGRESS_SUMMARY_MAX = 160;
/** Contract echo bound (`CONTRACT_ECHO_MAX` in `@yantra/agent`). */
export const CONTRACT_SUMMARY_MAX = 400;

/** Makes an inferred schema type deeply readonly, the way the runtime types were declared. */
export type Frozen<T> = T extends readonly (infer U)[]
  ? readonly Frozen<U>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;

const At = z.string().datetime().describe('ISO-8601 UTC timestamp of emission.');

/** One requirement's live state, as the progress ledger reports it. */
export const LiveItem = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Requirement id, such as `fill:email` or `artifact:screenshot:viewport`.'),
    kind: z
      .enum(['fill', 'artifact', 'effects', 'deliverable'])
      .describe('What kind of requirement the item tracks.'),
    label: z
      .string()
      .max(LIVE_ITEM_LABEL_MAX)
      .describe('Short human label, at most 60 characters.'),
    state: z
      .enum(['pending', 'advancing', 'met'])
      .describe('pending (untouched), advancing (related work happened), or met.'),
    done: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Units done, or null when not counted.'),
    total: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Units required, or null when not counted.'),
  })
  .describe('One declared requirement and how far the run has got with it.');

export type LiveItem = Frozen<z.infer<typeof LiveItem>>;

/**
 * The field shapes of every agent progress variant, in emission key order
 * (after the discriminator). Shared by `AgentProgressEvent` (`type`) and
 * `RunEvent` (`kind`).
 */
export const AGENT_PROGRESS_SHAPES = {
  recovery: {
    rung: z.enum(['steer', 'freeze', 'stop']).describe('The recovery rung that fired.'),
    trigger: z
      .enum(['stalled', 'turn-timeout'])
      .describe('What triggered recovery: no progress, or a turn over its thinking limit.'),
    move: z
      .enum(['fill-remaining', 'list-fields', 'capture', 'publish'])
      .nullable()
      .describe('The next supported move the run was steered to, or null on stop.'),
    summary: z.string().describe('One-line, render-safe description of the recovery step.'),
    at: At,
  },
  progress: {
    items: z.array(LiveItem).describe('Every declared requirement and its live state.'),
    summary: z
      .string()
      .max(PROGRESS_SUMMARY_MAX)
      .describe('One-line progress summary, at most 160 characters.'),
    at: At,
  },
  assistant_text: {
    text: z.string().describe('A sanitized chunk of the model’s streamed reply.'),
    at: At,
  },
  tool_started: {
    tool: z.string().min(1).describe('Tool name.'),
    summary: z.string().describe('Bounded input summary (field names only, never values).'),
    at: At,
  },
  tool_finished: {
    tool: z.string().min(1).describe('Tool name.'),
    summary: z.string().describe('Bounded result summary: status and error code only.'),
    status: z.enum(['ok', 'error', 'denied', 'aborted']).describe('How the call ended.'),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('Call duration in milliseconds, or null when the start was not observed.'),
    at: At,
  },
  contract_declared: {
    revision: z.number().int().positive().describe('1-based contract revision.'),
    summary: z
      .string()
      .max(CONTRACT_SUMMARY_MAX)
      .describe('One-line echo of the normalized, sanitized contract.'),
    at: At,
  },
  capability_gap: {
    item: z.string().min(1).describe('The requirement id, such as `artifact:screenshot:viewport`.'),
    reason: DeliverableCaptureReason.describe('Why the item cannot be delivered.'),
    summary: z.string().describe('One-line, ASCII-only disclosure; the run continues.'),
    at: At,
  },
} as const;

/** Every agent progress discriminator value. */
export type AgentProgressKind = keyof typeof AGENT_PROGRESS_SHAPES;

/** The agent progress discriminator values, in declaration order. */
export const AGENT_PROGRESS_KINDS = Object.keys(
  AGENT_PROGRESS_SHAPES,
) as readonly AgentProgressKind[];

const DESCRIPTIONS: Readonly<Record<AgentProgressKind, string>> = {
  recovery: 'The stall/turn-limit recovery ladder fired a rung.',
  progress: 'Declared requirements advanced.',
  assistant_text: 'The model streamed reply text.',
  tool_started: 'A tool call started.',
  tool_finished: 'A tool call finished.',
  contract_declared: 'A task contract revision was declared and echoed.',
  capability_gap: 'A declared item cannot be delivered by this run.',
};

/** Builds one variant object with `discriminator` first, then the shared fields. */
export function agentProgressVariant<D extends string, K extends AgentProgressKind>(
  discriminator: D,
  kind: K,
): z.ZodObject<Record<D, z.ZodLiteral<K>> & (typeof AGENT_PROGRESS_SHAPES)[K]> {
  return z.object({
    [discriminator]: z.literal(kind).describe(DESCRIPTIONS[kind]),
    ...AGENT_PROGRESS_SHAPES[kind],
  } as Record<D, z.ZodLiteral<K>> & (typeof AGENT_PROGRESS_SHAPES)[K]);
}

/** Bounded, render-safe progress sent from the agent runtime to a connector. */
export const AgentProgressEvent = z
  .discriminatedUnion('type', [
    agentProgressVariant('type', 'recovery'),
    agentProgressVariant('type', 'progress'),
    agentProgressVariant('type', 'assistant_text'),
    agentProgressVariant('type', 'tool_started'),
    agentProgressVariant('type', 'tool_finished'),
    agentProgressVariant('type', 'contract_declared'),
    agentProgressVariant('type', 'capability_gap'),
  ])
  .describe('Agent progress event, discriminated by `type` (the connector shape).');

export type AgentProgressEvent = Frozen<z.infer<typeof AgentProgressEvent>>;
