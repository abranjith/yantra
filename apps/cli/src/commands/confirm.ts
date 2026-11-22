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

import { ParkedDecisionService, createConfirmationStore, runsRoot } from '@yantra/core';
import type { ConfirmationDecision, DecisionResponse } from '@yantra/protocol';
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext, ExitCode } from '../context/command-context.js';
import { decideIntervention } from '../interventions/decide-intervention.js';
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
function decisionForOutput(
  response: DecisionResponse,
  confirmationId: string | undefined,
): ConfirmationDecision | null {
  if (response.status === 'accepted') return response.decision;
  if (response.status === 'already_decided' && confirmationId !== undefined) {
    return {
      confirmation_id: confirmationId,
      decision: response.decision,
      decided_at: response.decided_at,
      decided_by: response.decided_by,
    };
  }
  return null;
}

export function confirmHandlers(context: CommandContext = createTerminalContext()) {
  return {
    confirm: fromAction(async (runId: string, decisionArg: string, options: ConfirmOptions) => {
      try {
        if (decisionArg !== 'grant' && decisionArg !== 'deny') {
          context.output.stderr.write(
            `Invalid decision "${decisionArg}": expected "grant" or "deny"\n`,
          );
          return { exitCode: 1 as ExitCode };
        }

        const runDir = `${runsRoot()}/${runId}`;
        const store = createConfirmationStore(runDir);

        const pendingRequest = await store.findPending(runId);
        const request = pendingRequest ?? (await store.latestRequest(runId));
        const requestedDecision = decisionArg === 'grant' ? 'granted' : 'denied';
        const outcome =
          request === null
            ? null
            : await decideIntervention({
                runDir,
                runId,
                confirmationId: request.confirmation_id,
                decision: requestedDecision,
                decidedBy: 'user_cli_confirm',
              });
        if (outcome?.kind === 'owner_unreachable') {
          context.output.stderr.write(
            'The live run owner could not be reached or its channel is incompatible; no parked claim was written.\n',
          );
          return { exitCode: 3 as ExitCode };
        }
        const response =
          outcome?.response ??
          (await new ParkedDecisionService().decideParked({
            runDir,
            runId,
            decision: requestedDecision,
            decidedBy: 'user_cli_confirm',
          }));
        const responseCase = outcome?.case ?? 'parked';

        if (response.status === 'stale' && request === null) {
          const message = `No pending confirmation found for run "${runId}".`;
          if (options.json === true) {
            context.output.json({ error: message, runId }, { indent: 2 });
          } else {
            context.output.stderr.write(`${message}\n`);
          }
          return { exitCode: 1 as ExitCode };
        }

        const decision = decisionForOutput(response, request?.confirmation_id);
        if (options.json === true) {
          context.output.json(
            { runId, decision, request, case: responseCase, response },
            { indent: 2 },
          );
        } else if (response.status === 'accepted') {
          const location =
            responseCase === 'live' && request !== null
              ? `, step ${request.step_id}, ${request.action_kind} on ${request.host}`
              : '';
          context.output.stdout.write(
            `Decided (${responseCase} run${location}): ${response.decision.decision}\n`,
          );
        } else if (response.status === 'already_decided') {
          context.output.stdout.write(
            `Already decided by ${response.decided_by} at ${response.decided_at}\n`,
          );
        } else if (response.status === 'expired') {
          context.output.stderr.write(`Confirmation expired at ${response.decided_at}\n`);
        } else {
          context.output.stderr.write(`No pending confirmation found for run "${runId}".\n`);
        }

        return { exitCode: response.status === 'accepted' ? 0 : 1 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        context.output.stderr.write(`Error: ${message}\n`);
        return { exitCode: 1 as ExitCode };
      }
    }),
  };
}
