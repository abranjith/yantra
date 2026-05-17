import { EthicsRefusedError } from '../executor/errors.js';
import type { EthicsGate as ExecutorEthicsGate } from '../executor/types.js';

export type BlockedReason = 'robots' | 'blocklist' | 'rate-limit';

export interface AskEthicsGate {
  checkUrl(
    url: string,
  ): Promise<{ ok: true } | { ok: false; reason: BlockedReason; detail: string }>;
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
    async checkUrl(
      url: string,
    ): Promise<{ ok: true } | { ok: false; reason: BlockedReason; detail: string }> {
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
