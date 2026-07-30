/**
 * `SynthesisLlm` over a zero-tool agent session (FEAT-FP-001, TASK-003).
 *
 * ## The pattern: an agent session as a completion endpoint
 *
 * Core's LLM synthesis strategy needs one thing from a model — send a
 * system/user pair, get text back. Yantra already has exactly one governed path
 * to a model: the `AgentProvider` seam. So instead of introducing a second
 * provider client, this adapter opens a **single session with no tools at all**
 * (`PiAgentProvider` takes its tool set through constructor options — supply
 * none and the session has nothing to call), runs the user prompt, and collects
 * the `assistant_text` deltas.
 *
 * That beats a parallel client on every axis that matters here:
 *
 * - **One auth path.** `--auth-secret` / managed credentials resolve exactly as
 *   they do for `ask`/`research`/`do`; no second credential story to audit.
 * - **One model-selection surface.** `--provider` / `--model` / `--thinking`
 *   come from `agent-model.ts` verbatim, so `run` cannot drift from `ask`.
 * - **No new dependency.** No provider SDK is added, and the SDK stays behind
 *   the existing `packages/agent/src/adapters/pi/` seam.
 * - **Existing observability.** The session log lands under the run directory
 *   like any other session, so a synthesized Brief is auditable.
 *
 * ## Why this file lives in `apps/cli`
 *
 * The port it implements is declared in `packages/core/src/synthesis/types.ts`
 * precisely so `core` never imports `agent`; something above both must adapt
 * one to the other, and `apps/cli` is that layer. The name `SynthesisLlm` is
 * also deliberate: the legacy task-shaped client symbol is a tombstoned
 * forbidden symbol inside `@yantra/agent`
 * (`packages/agent/tests/boundaries/forbidden.ts`), and keeping this adapter in
 * `apps/cli` under the port's own name is what lets that boundary hold.
 *
 * Failures are returned, never thrown: startup problems degrade to
 * `llm_unavailable` and in-flight problems to `llm_failed`, both of which
 * `LlmSynthesizer` answers by falling back to the deterministic Brief.
 */

import type {
  AgentAuthSelection,
  AgentModelSelection,
  AgentProvider,
  AgentUsage,
} from '@yantra/agent';
import { AgentStartupError } from '@yantra/agent';
import type {
  Logger,
  SynthesisLlm,
  SynthesisLlmError,
  SynthesisLlmRequest,
  SynthesisLlmResponse,
  SynthesisLlmUsage,
} from '@yantra/core';
import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

/** Construction inputs for {@link createSynthesisLlm}. */
export interface SynthesisLlmOptions {
  /** The provider seam. Construct it with **no** tools for synthesis use. */
  readonly provider: AgentProvider;
  /** Provider/model coordinates, resolved by `selectAgentSession`. */
  readonly model: AgentModelSelection;
  /** Credential selection, resolved by `selectAgentSession`. */
  readonly auth: AgentAuthSelection;
  /** Owning run id — the session is an artifact of this run. */
  readonly runId: string;
  /** Owning run directory; the session log lands under `<runDir>/agent/`. */
  readonly runDir: string;
  /** Working directory recorded for the session (never used for discovery). */
  readonly cwd: string;
  /** Structured logger. Prompt bodies are never logged. */
  readonly logger: Logger;
}

/**
 * Startup codes that a retry cannot fix. A missing model or an unusable
 * credential will fail identically on the next attempt, and an abort was the
 * user's decision.
 */
const NON_RETRYABLE_CODES = new Set([
  'AGENT_MODEL_NOT_FOUND',
  'AGENT_AUTH_UNAVAILABLE',
  'AGENT_ABORTED',
]);

/**
 * Builds the synthesis LLM port over a zero-tool agent session.
 *
 * @param opts - Provider seam, model/auth selection, and run identity.
 * @returns A `SynthesisLlm` whose `send` opens, uses, and closes exactly one
 *   session per call, and which never throws.
 *
 * @example
 * const llm = createSynthesisLlm({
 *   provider: new PiAgentProvider(), // no customTools → pure completion
 *   model, auth, runId, runDir, cwd: process.cwd(), logger,
 * });
 * new LlmSynthesizer({ llm, prompt: YANTRA_SYNTHESIS_PROMPT, deterministic });
 */
export function createSynthesisLlm(opts: SynthesisLlmOptions): SynthesisLlm {
  const providerId = `${opts.model.provider}:${opts.model.id}`;

  return {
    providerId,

    async send(
      request: SynthesisLlmRequest,
    ): Promise<Result<SynthesisLlmResponse, SynthesisLlmError>> {
      let session;
      try {
        session = await opts.provider.open({
          runId: opts.runId,
          runDir: opts.runDir,
          cwd: opts.cwd,
          model: opts.model,
          auth: opts.auth,
          // The template's system prompt is the session's system prompt: no
          // ambient prompt sources are consulted by the seam.
          systemPrompt: request.system,
        });
      } catch (error) {
        // Startup never degrades to a null provider — it degrades to "no LLM
        // synthesis", which `LlmSynthesizer` answers with the deterministic Brief.
        // A typed `AgentStartupError` is the expected shape (bad model, no
        // credential, provider unreachable); anything else is logged as
        // unexpected but maps to the same outcome.
        const startup = error instanceof AgentStartupError ? error.toAgentError() : null;
        const message = error instanceof Error ? error.message : String(error);
        opts.logger.warn(
          { providerId, ...(startup === null ? { typed: false } : { code: startup.code }) },
          'synthesis llm session unavailable',
        );
        return err({ kind: 'llm_unavailable', message });
      }

      let text = '';
      let turnUsage: AgentUsage | null = null;
      let failure: { readonly code: string; readonly message: string } | null = null;

      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case 'assistant_text':
            text += event.text;
            return;
          case 'turn_finished':
            turnUsage = event.usage;
            return;
          case 'failed':
            failure = event.error;
            return;
          default:
            return;
        }
      });

      try {
        const result = await session.run(request.user);

        if (failure !== null) {
          return err(failedError(failure, providerId, opts.logger));
        }

        if (result.outcome !== 'completed') {
          opts.logger.warn(
            { providerId, outcome: result.outcome },
            'synthesis llm run did not complete',
          );
          return err({
            kind: 'llm_failed',
            message: `synthesis session ${result.outcome} (${result.stopReason})`,
            retryable: result.outcome !== 'aborted',
          });
        }

        const usage = toSynthesisUsage(turnUsage ?? result.usage);
        opts.logger.debug({ providerId, usage }, 'synthesis llm response received');
        return ok({ text, usage });
      } catch (error) {
        // `run()` rejects only on misuse, but a rejection must still be a typed
        // Result rather than an exception escaping into the Synthesize stage.
        const message = error instanceof Error ? error.message : String(error);
        opts.logger.warn({ providerId }, 'synthesis llm run failed');
        return err({ kind: 'llm_failed', message, retryable: true });
      } finally {
        unsubscribe();
        // Always tear the session down: a leaked session holds a provider
        // connection open for the remainder of the run.
        await session.close().catch(() => undefined);
      }
    },
  };
}

/** Maps a `failed` session event onto the port's error union. */
function failedError(
  failure: { readonly code: string; readonly message: string },
  providerId: string,
  logger: Logger,
): SynthesisLlmError {
  if (failure.code === 'AGENT_MODEL_NOT_FOUND' || failure.code === 'AGENT_AUTH_UNAVAILABLE') {
    logger.warn({ providerId, code: failure.code }, 'synthesis llm session unavailable');
    return { kind: 'llm_unavailable', message: failure.message };
  }

  logger.warn({ providerId, code: failure.code }, 'synthesis llm session failed');
  return {
    kind: 'llm_failed',
    message: failure.message,
    retryable: !NON_RETRYABLE_CODES.has(failure.code),
  };
}

/**
 * Projects seam usage onto the port's usage shape.
 *
 * Returns null when the provider reported no token or cost figures at all —
 * `null` means "unknown", which is honest, whereas zeros would be a lie the
 * Brief's metadata would then carry.
 */
function toSynthesisUsage(usage: AgentUsage | undefined): SynthesisLlmUsage | null {
  if (usage === undefined) return null;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.costUsd === undefined
  ) {
    return null;
  }

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: usage.costUsd ?? 0,
  };
}
