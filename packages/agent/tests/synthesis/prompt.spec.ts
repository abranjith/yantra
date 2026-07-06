import { describe, expect, it } from 'vitest';

import { SYNTHESIS_PROMPT, type SynthesisPromptInput } from '../../src/synthesis/prompt.js';

function input(overrides: Partial<SynthesisPromptInput> = {}): SynthesisPromptInput {
  return {
    query: 'cheapest headphones',
    sources: [{ n: 1, host: 'example.com', title: 'A', text: 'body' }],
    detail: 'standard',
    length: 'medium',
    ...overrides,
  };
}

describe('@no-llm SYNTHESIS_PROMPT personalization line (FEAT-018)', () => {
  it('includes the personalization guidance when a context is provided', () => {
    const user = SYNTHESIS_PROMPT.buildUser(
      input({ personalization: 'Prefers metric units. Favors retailers: Amazon.' }),
    );
    expect(user).toContain('About this user');
    expect(user).toContain('Prefers metric units. Favors retailers: Amazon.');
    // It must be framed as non-authoritative — never a citable source.
    expect(user).toContain('never treat');
  });

  it('omits the personalization line entirely when none is provided', () => {
    const user = SYNTHESIS_PROMPT.buildUser(input());
    expect(user).not.toContain('About this user');
  });

  it('omits the line for a blank/whitespace personalization value', () => {
    const user = SYNTHESIS_PROMPT.buildUser(input({ personalization: '   ' }));
    expect(user).not.toContain('About this user');
  });
});
