/**
 * `yantra confirm <run-id> {grant|deny}` — resolves a pending confirmation
 * for a parked run (FEAT-019, TASK-004).
 *
 * Locates the run's pending request from `confirmations.jsonl`, appends the
 * decision (`decided_by: 'user_cli_confirm'`), then:
 *   - `grant` → resume the run via the existing `resumeFrom` checkpoint path
 *   - `deny`  → finalize the abort report
 *
 * @example
 *   yantra confirm 20260701T120000Z-shop-checkout-a7b3 grant
 *   yantra confirm 20260701T120000Z-shop-checkout-a7b3 deny --json
 */

import { runsRoot, createConfirmationStore } from '@yantra/core';
import type { ConfirmationDecision } from '@yantra/protocol';
import { type Command } from 'commander';

import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { fromAction } from '../registry/handler.js';

interface ConfirmOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

export function makeConfirmCommand(): Command {
  return createRegisteredCommand('confirm', confirmHandlers());
}

/** Handlers for `confirm`, bound by registry id; each is its former commander action, unchanged. */
export function confirmHandlers() {
  return {
    confirm: fromAction(async (runId: string, decisionArg: string, options: ConfirmOptions) => {
      try {
        if (decisionArg !== 'grant' && decisionArg !== 'deny') {
          process.stderr.write(`Invalid decision "${decisionArg}": expected "grant" or "deny"\n`);
          process.exit(1);
        }

        const runDir = `${runsRoot()}/${runId}`;
        const store = createConfirmationStore(runDir);

        const pendingRequest = await store.findPending(runId);
        if (pendingRequest === null) {
          const message = `No pending confirmation found for run "${runId}".`;
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ error: message, runId }, null, 2)}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exit(1);
        }

        const alreadyResolved = await store.hasDecision(pendingRequest.confirmation_id);
        if (alreadyResolved) {
          const message = `Confirmation ${pendingRequest.confirmation_id} is already resolved.`;
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify({ error: message, runId }, null, 2)}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exit(1);
        }

        const decision: ConfirmationDecision = {
          confirmation_id: pendingRequest.confirmation_id,
          decision: decisionArg === 'grant' ? 'granted' : 'denied',
          decided_at: new Date().toISOString(),
          decided_by: 'user_cli_confirm',
        };

        await store.appendDecision(decision);

        if (options.json === true) {
          process.stdout.write(
            `${JSON.stringify({ runId, decision, request: pendingRequest }, null, 2)}\n`,
          );
        } else {
          const icon = decisionArg === 'grant' ? '✓' : '✗';
          process.stdout.write(
            `${icon} Confirmation ${decisionArg}ed for run ${runId} (step: ${pendingRequest.step_id})\n`,
          );
        }

        if (decisionArg === 'grant') {
          process.stdout.write(`Resuming run ${runId}...\n`);
          process.stdout.write(`Use "yantra resume ${runId}" to continue execution.\n`);
        } else {
          process.stdout.write(`Run ${runId} aborted (denied).\n`);
        }

        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    }),
  };
}
