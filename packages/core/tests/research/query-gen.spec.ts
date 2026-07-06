import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  FollowUpQueryGenerator,
  MAX_QUERIES_PER_HOP,
  filterNovel,
  isValidQuery,
  parseQueries,
  type ResearchQueryPromptTemplate,
} from '../../src/research/query-gen.js';
import * as sanitizerModule from '../../src/sanitizer/index.js';
import type {
  SynthesisLlm,
  SynthesisLlmError,
  SynthesisLlmRequest,
  SynthesisLlmResponse,
} from '../../src/synthesis/types.js';

/** A fake LLM port that returns a canned response and records requests. */
class FakeLlm implements SynthesisLlm {
  public readonly providerId = 'fake:test';
  public readonly requests: SynthesisLlmRequest[] = [];

  public constructor(private readonly reply: Result<SynthesisLlmResponse, SynthesisLlmError>) {}

  public send(
    request: SynthesisLlmRequest,
  ): Promise<Result<SynthesisLlmResponse, SynthesisLlmError>> {
    this.requests.push(request);
    return Promise.resolve(this.reply);
  }
}

/** A trivial prompt template echoing inputs so tests can inspect them. */
const fakePrompt: ResearchQueryPromptTemplate = {
  system: 'SYSTEM',
  buildUser: (input) =>
    `topic=${input.topic}\noverview=${input.overview}\ngaps=${input.gaps.join(',')}`,
};

function response(text: string): Result<SynthesisLlmResponse, SynthesisLlmError> {
  return ok({ text, usage: null });
}

const baseInput = {
  topic: 'renewable energy',
  gaps: ['grid storage', 'policy incentives'],
  interimOverview: 'Solar and wind grew. [1]',
  issuedQueries: ['renewable energy'],
  scope: 'public' as const,
  host: 'research',
};

describe('@no-llm research/query-gen helpers', () => {
  it('validates query length and rejects control characters', () => {
    expect(isValidQuery('grid storage costs')).toBe(true);
    expect(isValidQuery('ab')).toBe(false);
    expect(isValidQuery('x'.repeat(200))).toBe(false);
    expect(isValidQuery('badquery')).toBe(false);
    expect(isValidQuery('the and of')).toBe(false); // only stopwords
  });

  it('filters near-duplicate queries against the issued set', () => {
    const kept = filterNovel(
      ['renewable energy sources', 'grid storage options', 'renewable energy'],
      ['renewable energy'],
    );
    expect(kept).toContain('grid storage options');
    expect(kept).not.toContain('renewable energy');
  });

  it('parses a JSON array of query strings', () => {
    expect(parseQueries('["a query","another query"]')).toEqual(['a query', 'another query']);
  });

  it('parses newline/bulleted query lists when JSON is absent', () => {
    expect(parseQueries('- first query\n2) second query')).toEqual(['first query', 'second query']);
  });
});

describe('@no-llm research/query-gen deterministic path', () => {
  it('expands uncovered subtopics into novel, capped queries', async () => {
    const gen = new FollowUpQueryGenerator();

    const result = await gen.generate(baseInput);

    expect(result.usedLlm).toBe(false);
    expect(result.queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_HOP);
    expect(result.queries.length).toBeGreaterThan(0);
    // None repeats the already-issued query.
    expect(result.queries).not.toContain('renewable energy');
  });

  it('caps at MAX_QUERIES_PER_HOP even with many gaps', async () => {
    const gen = new FollowUpQueryGenerator();

    const result = await gen.generate({
      ...baseInput,
      gaps: ['alpha topic', 'beta topic', 'gamma topic', 'delta topic', 'epsilon topic'],
    });

    expect(result.queries.length).toBe(MAX_QUERIES_PER_HOP);
  });
});

describe('research/query-gen LLM path', () => {
  it('sanitizes the interim overview before it reaches the LLM port', async () => {
    const spy = vi.spyOn(sanitizerModule, 'sanitize');
    const llm = new FakeLlm(response('["grid battery storage","clean energy subsidies"]'));
    const gen = new FollowUpQueryGenerator({ llm, prompt: fakePrompt });

    await gen.generate({ ...baseInput, interimOverview: 'contact me at admin@example.com now' });

    // sanitize() ran on the overview before the port received anything.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some((call) => call[0] === 'contact me at admin@example.com now')).toBe(
      true,
    );
    expect(llm.requests).toHaveLength(1);
    // The raw email must not appear in what the port received.
    expect(llm.requests[0]?.user).not.toContain('admin@example.com');
    spy.mockRestore();
  });

  it('returns novel validated queries from a well-formed reply', async () => {
    const llm = new FakeLlm(response('["grid battery storage","clean energy subsidies"]'));
    const gen = new FollowUpQueryGenerator({ llm, prompt: fakePrompt });

    const result = await gen.generate(baseInput);

    expect(result.usedLlm).toBe(true);
    expect(result.queries).toEqual(['grid battery storage', 'clean energy subsidies']);
  });

  it('falls back to the deterministic path on an empty/malformed reply', async () => {
    const llm = new FakeLlm(response('   '));
    const gen = new FollowUpQueryGenerator({ llm, prompt: fakePrompt });

    const result = await gen.generate(baseInput);

    // No parseable queries → the generator falls back to deterministic expansion.
    expect(result.usedLlm).toBe(false);
    expect(result.queries.length).toBeGreaterThan(0);
  });

  it('falls back to the deterministic path when the port errors', async () => {
    const llm = new FakeLlm(err({ kind: 'llm_unavailable', message: 'no provider' }));
    const gen = new FollowUpQueryGenerator({ llm, prompt: fakePrompt });

    const result = await gen.generate(baseInput);

    expect(result.usedLlm).toBe(false);
    expect(result.queries.length).toBeGreaterThan(0);
  });
});
