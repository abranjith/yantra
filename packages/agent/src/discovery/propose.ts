/**
 * Discovery proposer — one propose→(validate)→re-prompt cycle (FEAT-020 TASK-002).
 *
 * `propose()` sends the goal + trimmed cycle history + latest observation to
 * the model via `LLMClient.summarize()` (the free-text-in/free-text-out method
 * on the real client interface — there is no `LLMClient.send`; `summarize` is
 * the closest existing primitive and gets `wrapWithAudit` request/response
 * logging for free, matching the audited-per-call requirement), parses the
 * response as JSON, and validates it with `@yantra/protocol`'s
 * `validateDiscoveryProposal` (schema + secret-ref + semantic-locator
 * refinements). On failure it re-prompts with the serialized issue paths,
 * bounded at {@link DEFAULT_MAX_REPROMPTS} attempts — the same convention as
 * `runGeneratePlan`. A valid proposal is passed through `normalizeProposal`
 * (forces `requires_confirmation` on mutating verbs) before being returned.
 *
 * Every string handed to `LLMClient.summarize` is built here, immediately
 * branded via `brandSanitized`, and defense-in-depth-checked with
 * `assertSanitized` — the observation content it's built from was already
 * sanitized upstream by `packages/core/src/discovery/observe.ts` (core's own
 * `Sanitized<T>` brand); this module never reads a `history` row, only the
 * `DiscoverySessionState` cycle log (proposals + observations), so raw
 * run-history text has no path into this prompt either.
 */

import { err, ok, type Result } from '@yantra/protocol';
import {
  normalizeProposal,
  validateDiscoveryProposal,
  type DiscoveryProposal,
} from '@yantra/protocol';

import type { LLMBudget, LLMClient, LLMError } from '../client/interface.js';
import { assertSanitized, brandSanitized } from '../sanitizer-guard.js';

import { DISCOVERY_PROMPT, type DiscoveryPromptTemplate } from './prompts.js';
import { trimHistoryForPrompt, type DiscoverySessionState } from './session-state.js';

/** Bounded re-prompt budget on proposal-validation failure (memory convention). */
export const DEFAULT_MAX_REPROMPTS = 2;

/** Constructor-style dependencies for {@link propose}. */
export interface ProposeDeps {
  /** The (possibly `wrapWithAudit`-wrapped) LLM client. */
  readonly client: LLMClient;
  /** Prompt template; defaults to {@link DISCOVERY_PROMPT}. */
  readonly prompt?: DiscoveryPromptTemplate;
  /** Re-prompt budget; defaults to {@link DEFAULT_MAX_REPROMPTS}. */
  readonly maxReprompts?: number;
}

/** Per-call options for {@link propose}. */
export interface ProposeOpts {
  readonly runId: string;
  readonly taskId: string;
  readonly budget: LLMBudget;
}

/** Failure returned (never thrown) by {@link propose}. */
export type ProposeError =
  | { readonly kind: 'llm_error'; readonly error: LLMError }
  | {
      readonly kind: 'validation_failed';
      readonly attempts: number;
      readonly reasons: readonly string[];
    };

/**
 * Proposes the next discovery cycle from the current session state.
 *
 * @param state - Current session state (goal, allowlist, cycle history).
 * @param deps - The LLM client + prompt template + re-prompt budget.
 * @param opts - Per-call run/task ids and LLM budget.
 * @returns A normalized, schema-valid {@link DiscoveryProposal}, or a
 *   {@link ProposeError} on LLM failure or re-prompt exhaustion.
 */
export async function propose(
  state: DiscoverySessionState,
  deps: ProposeDeps,
  opts: ProposeOpts,
): Promise<Result<DiscoveryProposal, ProposeError>> {
  const prompt = deps.prompt ?? DISCOVERY_PROMPT;
  const maxReprompts = deps.maxReprompts ?? DEFAULT_MAX_REPROMPTS;

  // The system prompt is our own static text; the user message is built
  // entirely from the session's own proposal/observation log (never a raw
  // history row) — both are safe to brand at the point of construction.
  const systemPrompt = brandSanitized(prompt.system);
  let userMessage = brandSanitized(
    prompt.buildUser({
      goal: state.goal,
      hostAllowlist: state.hostAllowlist,
      history: trimHistoryForPrompt(state),
    }),
  );

  // Defense-in-depth: assert both values are registered as sanitized before
  // the first call. Every subsequent re-prompt message is also produced by
  // brandSanitized() (never raw), so a per-iteration re-assert is redundant.
  assertSanitized(systemPrompt);
  assertSanitized(userMessage);

  let lastReasons: string[] = [];

  for (let attempt = 0; attempt <= maxReprompts; attempt++) {
    const result = await deps.client.summarize({
      sanitizedInput: userMessage,
      sanitizedPrompt: systemPrompt,
      budget: opts.budget,
      runId: opts.runId,
      taskId: opts.taskId,
    });

    if (!result.isOk) {
      return err({ kind: 'llm_error', error: result.error });
    }

    const parsed = parseProposalJson(result.value.text);
    if (!parsed.isOk) {
      lastReasons = [parsed.error];
      userMessage = brandSanitized(prompt.buildReprompt(lastReasons));
      continue;
    }

    const validated = validateDiscoveryProposal(parsed.value);
    if (!validated.success) {
      lastReasons = validated.error.issues.map(
        (issue) => `${issue.path.join('/') || '(root)'}: ${issue.message}`,
      );
      userMessage = brandSanitized(prompt.buildReprompt(lastReasons));
      continue;
    }

    return ok(normalizeProposal(validated.data));
  }

  return err({
    kind: 'validation_failed',
    attempts: maxReprompts + 1,
    reasons: lastReasons,
  });
}

/**
 * Extracts the first balanced `{...}` object from arbitrary model text and
 * parses it as JSON. Tolerates leading/trailing prose and code fences.
 */
function parseProposalJson(responseText: string): Result<unknown, string> {
  const start = responseText.indexOf('{');
  if (start === -1) {
    return err('response did not contain a JSON object');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < responseText.length; i += 1) {
    const char = responseText[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = responseText.slice(start, i + 1);
        try {
          return ok(JSON.parse(jsonText) as unknown);
        } catch (error) {
          return err(
            `response was not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
          );
        }
      }
    }
  }

  return err('response JSON object was never closed (unbalanced braces)');
}
