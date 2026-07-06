/**
 * Synthesizer strategy selection.
 *
 * Mirrors `selectSearchProvider` (`extraction/search/provider.ts`) and the
 * `LLMClient` factory: callers hand in the available strategies and flags,
 * and the selector applies the plan's rules — determinism is always
 * reachable, the LLM is only chosen when it is actually available.
 */

import type { SynthesisOptions, Synthesizer } from './types.js';

/** Dependencies available to {@link selectSynthesizer}. */
export interface SelectSynthesizerDeps {
  /** The always-available deterministic strategy. */
  readonly deterministic: Synthesizer;
  /** The LLM strategy, or null when no LLM port is wired (LLM_PROVIDER=none). */
  readonly llm: Synthesizer | null;
  /** True when the user passed `--no-llm`; forces the deterministic path. */
  readonly noLlm?: boolean;
}

/**
 * Selects the synthesizer strategy for one invocation.
 *
 * Rules, in priority order:
 * 1. `--no-llm` → deterministic (the agent-optional invariant).
 * 2. `opts.strategy: 'deterministic'` → deterministic.
 * 3. No LLM port wired → deterministic.
 * 4. `opts.strategy: 'llm'` → llm (sanitizer profile still applies per scope).
 * 5. `opts.strategy: 'auto'` → llm for `public` scope, deterministic otherwise.
 *
 * @param opts - The synthesis options carrying strategy + scope.
 * @param deps - Available strategy instances and the no-llm flag.
 * @returns The synthesizer to run; never null — deterministic always exists.
 *
 * @example
 * const synthesizer = selectSynthesizer(opts, {
 *   deterministic: new DeterministicSynthesizer(),
 *   llm: llmPort ? new LlmSynthesizer({ llm: llmPort, prompt }) : null,
 *   noLlm: flags.noLlm,
 * });
 */
export function selectSynthesizer(
  opts: Pick<SynthesisOptions, 'strategy' | 'scope'>,
  deps: SelectSynthesizerDeps,
): Synthesizer {
  if (deps.noLlm === true) {
    return deps.deterministic;
  }

  if (opts.strategy === 'deterministic') {
    return deps.deterministic;
  }

  if (deps.llm === null) {
    return deps.deterministic;
  }

  if (opts.strategy === 'llm') {
    return deps.llm;
  }

  // 'auto': LLM only for public-scope content; everything else stays
  // deterministic until stricter-scope synthesis lands (FEAT-015+).
  return opts.scope === 'public' ? deps.llm : deps.deterministic;
}
