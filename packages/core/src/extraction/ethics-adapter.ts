import { EthicsRefusedError } from '../executor/errors.js';
import type { EthicsGate as ExecutorEthicsGate } from '../executor/types.js';

/** An ethics refusal reason: the site's own policy (or Yantra's blocklist of it). */
export type BlockedReason = 'robots' | 'blocklist' | 'rate-limit';

/** Which run budget a `budget` refusal spent. */
export type BudgetLimitName = 'navigations' | 'hosts';

/**
 * A per-URL gate decision. Ethics refusals carry a {@link BlockedReason}; the
 * run's own refusals are separate variants so they can never be mistaken for
 * the site blocking the run: `budget` (a spent navigation/host budget) and
 * `policy` (the outbound URL policy, by its stable code).
 */
export type AskEthicsDecision =
  | { ok: true }
  | { ok: false; reason: BlockedReason; detail: string }
  | { ok: false; reason: 'budget'; detail: string; limit: BudgetLimitName }
  | { ok: false; reason: 'policy'; detail: string; code: string };

export interface AskEthicsGate {
  checkUrl(url: string): Promise<AskEthicsDecision>;
}

export interface AskEthicsAdapterContext {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly action: 'navigate' | 'fetch';
}

/**
 * Adapts executor ethics gate API to the ask-pipeline shape.
 */
export function createAskEthicsAdapter(
  gate: ExecutorEthicsGate,
  context: AskEthicsAdapterContext,
): AskEthicsGate {
  return {
    async checkUrl(url: string): Promise<AskEthicsDecision> {
      try {
        await gate.check(url, context.action, {
          taskId: context.taskId,
          runId: context.runId,
          stepId: context.stepId,
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof EthicsRefusedError) {
          return {
            ok: false,
            reason: mapReason(error.ethicsContext.source),
            detail: error.ethicsContext.reason,
          };
        }
        throw error;
      }
    },
  };
}

function mapReason(source: 'robots' | 'blocklist' | 'rate_limit'): BlockedReason {
  if (source === 'robots') {
    return 'robots';
  }
  if (source === 'blocklist') {
    return 'blocklist';
  }
  return 'rate-limit';
}
