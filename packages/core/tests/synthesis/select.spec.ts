import { describe, expect, it } from 'vitest';

import { selectSynthesizer, type SelectSynthesizerDeps } from '../../src/synthesis/select.js';
import { SynthesisError, type Synthesizer } from '../../src/synthesis/types.js';

function fakeSynthesizer(strategy: 'deterministic' | 'llm'): Synthesizer {
  return {
    strategy,
    synthesize: () => Promise.reject(new Error('not called in selection tests')),
  };
}

const deterministic = fakeSynthesizer('deterministic');
const llm = fakeSynthesizer('llm');

function deps(overrides: Partial<SelectSynthesizerDeps> = {}): SelectSynthesizerDeps {
  return { deterministic, llm, ...overrides };
}

describe('@no-llm synthesis/selectSynthesizer', () => {
  it('forces the deterministic strategy when the no-llm flag is set, even for explicit llm requests', () => {
    const selected = selectSynthesizer({ strategy: 'llm', scope: 'public' }, deps({ noLlm: true }));

    expect(selected).toBe(deterministic);
  });

  it('honors an explicit deterministic strategy request when an LLM is available', () => {
    const selected = selectSynthesizer({ strategy: 'deterministic', scope: 'public' }, deps());

    expect(selected).toBe(deterministic);
  });

  it('falls back to deterministic when no LLM port is wired (LLM_PROVIDER=none)', () => {
    expect(selectSynthesizer({ strategy: 'auto', scope: 'public' }, deps({ llm: null }))).toBe(
      deterministic,
    );
    expect(selectSynthesizer({ strategy: 'llm', scope: 'public' }, deps({ llm: null }))).toBe(
      deterministic,
    );
  });

  it('selects the llm strategy for an explicit llm request when available', () => {
    expect(selectSynthesizer({ strategy: 'llm', scope: 'public' }, deps())).toBe(llm);
    expect(selectSynthesizer({ strategy: 'llm', scope: 'authenticated' }, deps())).toBe(llm);
  });

  it('resolves auto to llm only for public scope', () => {
    expect(selectSynthesizer({ strategy: 'auto', scope: 'public' }, deps())).toBe(llm);
    expect(selectSynthesizer({ strategy: 'auto', scope: 'read-only-data' }, deps())).toBe(
      deterministic,
    );
    expect(selectSynthesizer({ strategy: 'auto', scope: 'authenticated' }, deps())).toBe(
      deterministic,
    );
  });

  it('always returns a synthesizer for every point of the selection matrix', () => {
    const strategies = ['auto', 'deterministic', 'llm'] as const;
    const scopes = ['public', 'read-only-data', 'authenticated'] as const;
    const llmAvailability = [llm, null] as const;
    const noLlmFlags = [true, false, undefined] as const;

    for (const strategy of strategies) {
      for (const scope of scopes) {
        for (const available of llmAvailability) {
          for (const noLlm of noLlmFlags) {
            const selected = selectSynthesizer(
              { strategy, scope },
              deps({ llm: available, noLlm }),
            );

            expect([deterministic, llm]).toContain(selected);
            if (noLlm === true || available === null) {
              expect(selected).toBe(deterministic);
            }
          }
        }
      }
    }
  });
});

describe('@no-llm synthesis/SynthesisError', () => {
  it('carries the query and strategy context for failure reports', () => {
    const cause = new Error('parse failed');
    const error = new SynthesisError('LLM response was not valid JSON', {
      query: 'cheapest sony wh-1000xm5',
      strategy: 'llm',
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SynthesisError');
    expect(error.message).toBe('LLM response was not valid JSON');
    expect(error.context.query).toBe('cheapest sony wh-1000xm5');
    expect(error.context.strategy).toBe('llm');
    expect(error.context.cause).toBe(cause);
  });
});
