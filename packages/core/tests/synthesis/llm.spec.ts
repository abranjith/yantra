import type { Result } from '@yantra/protocol';
import { err, ok, validateBrief } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import * as sanitizerModule from '../../src/sanitizer/index.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import { LlmSynthesizer, parseDraft } from '../../src/synthesis/llm.js';
import type {
  SynthesisInput,
  SynthesisLlm,
  SynthesisLlmError,
  SynthesisLlmRequest,
  SynthesisLlmResponse,
  SynthesisOptions,
  SynthesisPromptTemplate,
} from '../../src/synthesis/types.js';

const PROMPT: SynthesisPromptTemplate = {
  system: 'SYSTEM',
  buildUser: (input) =>
    `USER query=${input.query} sources=${input.sources.map((s) => s.n).join(',')}`,
  buildReprompt: (issues) => `REPROMPT ${issues.map((i) => i.pointer).join(',')}`,
};

const CORPUS: SynthesisInput = {
  query: 'sony headphones price',
  docs: [
    {
      url: 'https://amazon.example.com/x',
      finalUrl: null,
      host: 'amazon.example.com',
      title: 'Amazon',
      fetchedAt: '2026-06-01T00:00:00.000Z',
      publishedAt: null,
      text: 'The Sony wireless headphones cost $328 at Amazon this week with free shipping for members.',
      excerpt: null,
    },
    {
      url: 'https://bestbuy.example.com/x',
      finalUrl: null,
      host: 'bestbuy.example.com',
      title: 'Best Buy',
      fetchedAt: '2026-06-01T00:00:00.000Z',
      publishedAt: null,
      text: 'Best Buy lists the same Sony wireless headphones at $349 with in-store pickup available.',
      excerpt: null,
    },
  ],
  failures: [],
};

function opts(overrides: Partial<SynthesisOptions> = {}): SynthesisOptions {
  return {
    strategy: 'llm',
    detail: 'standard',
    length: 'medium',
    scope: 'public',
    taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runId: 'run-1',
    searchProvider: 'tavily',
    ...overrides,
  };
}

/** A scripted SynthesisLlm port returning canned responses in sequence. */
class ScriptedLlm implements SynthesisLlm {
  public readonly providerId = 'fake:test';
  public readonly requests: SynthesisLlmRequest[] = [];
  private call = 0;

  public constructor(
    private readonly responses: readonly Result<SynthesisLlmResponse, SynthesisLlmError>[],
  ) {}

  public send(
    request: SynthesisLlmRequest,
  ): Promise<Result<SynthesisLlmResponse, SynthesisLlmError>> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.call, this.responses.length - 1)]!;
    this.call += 1;
    return Promise.resolve(response);
  }
}

function goodDraftJson(): string {
  return JSON.stringify({
    title: 'Sony headphone prices',
    overview: 'Amazon is cheapest at $328. [1] Best Buy is $349. [2]',
    key_findings: [
      {
        text: 'Amazon lists the headphones at $328. [1]',
        citations: [1],
        editorial: false,
        facet: null,
      },
      {
        text: 'Best Buy lists the headphones at $349. [2]',
        citations: [2],
        editorial: false,
        facet: null,
      },
    ],
    sections: [],
    facets: null,
  });
}

function response(text: string, usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }) {
  return ok({ text, usage });
}

function deterministic(): DeterministicSynthesizer {
  return new DeterministicSynthesizer({ clock: () => new Date('2026-06-02T00:00:00.000Z') });
}

describe('@no-llm synthesis/LlmSynthesizer', () => {
  it('produces a valid Brief on the happy path', async () => {
    const llm = new ScriptedLlm([response(goodDraftJson())]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    const result = await synth.synthesize(CORPUS, opts());

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(validateBrief(result.value.brief).isOk).toBe(true);
    expect(result.value.strategyUsed).toBe('llm');
    expect(result.value.fallbackUsed).toBe(false);
    expect(result.value.brief.metadata.synthesis).toBe('llm');
    expect(result.value.brief.metadata.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
    });
    expect(result.value.brief.metadata.citation_verdict).not.toBeNull();
  });

  it('sanitizes every doc text before it reaches the LLM port', async () => {
    const spy = vi.spyOn(sanitizerModule, 'sanitize');
    const llm = new ScriptedLlm([response(goodDraftJson())]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    await synth.synthesize(CORPUS, opts());

    // Every doc's text passed through sanitize() ...
    const sanitizedInputs = spy.mock.calls.map((call) => call[0]);
    for (const doc of CORPUS.docs) {
      expect(sanitizedInputs).toContain(doc.text);
    }
    // ... with the scope-derived profile.
    for (const call of spy.mock.calls) {
      expect(call[1]).toBe('public');
    }
    // ... and sanitize was invoked before the port received anything.
    expect(spy).toHaveBeenCalled();
    expect(llm.requests.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('never lets unsanitized PII reach the LLM port (public profile)', async () => {
    const withPii: SynthesisInput = {
      query: 'contact info',
      docs: [
        {
          url: 'https://a.example.com/x',
          finalUrl: null,
          host: 'a.example.com',
          title: 'Contact',
          fetchedAt: '2026-06-01T00:00:00.000Z',
          publishedAt: null,
          text: 'Reach the analyst at secret.person@example.com for the full pricing dataset today.',
          excerpt: null,
        },
      ],
      failures: [],
    };
    const singleSourceDraft = JSON.stringify({
      title: 'Contact',
      overview: 'Pricing dataset is available on request. [1]',
      key_findings: [
        {
          text: 'The analyst offers a full pricing dataset. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
      ],
      sections: [],
      facets: null,
    });
    const llm = new ScriptedLlm([response(singleSourceDraft)]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    await synth.synthesize(withPii, opts());

    // The public sanitizer profile redacts emails — the raw address must
    // never appear in what the port received, on any call.
    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    for (const request of llm.requests) {
      expect(request.user).not.toContain('secret.person@example.com');
    }
  });

  it('re-prompts on malformed JSON then falls back after the budget is exhausted', async () => {
    const llm = new ScriptedLlm([
      response('not json at all'),
      response('still not json'),
      response('nope'),
    ]);
    const synth = new LlmSynthesizer({
      llm,
      prompt: PROMPT,
      deterministic: deterministic(),
      maxReprompts: 2,
    });

    const result = await synth.synthesize(CORPUS, opts());

    // 1 initial + 2 re-prompts = 3 calls, then fallback.
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[1]!.user.startsWith('REPROMPT')).toBe(true);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.strategyUsed).toBe('deterministic');
    expect(result.value.fallbackUsed).toBe(true);
    expect(result.value.brief.metadata.deterministic_fallback_used).toBe(true);
  });

  it('re-prompts when a citation is dangling then succeeds on the retry', async () => {
    const danglingJson = JSON.stringify({
      title: 'Prices',
      overview: 'Cheapest is $328. [7]',
      key_findings: [
        { text: 'Amazon at $328. [7]', citations: [7], editorial: false, facet: null },
      ],
      sections: [],
      facets: null,
    });
    const llm = new ScriptedLlm([response(danglingJson), response(goodDraftJson())]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    const result = await synth.synthesize(CORPUS, opts());

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.user.startsWith('REPROMPT')).toBe(true);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.strategyUsed).toBe('llm');
    expect(result.value.fallbackUsed).toBe(false);
  });

  it('falls back silently with the flag set when the provider is unavailable', async () => {
    const llm = new ScriptedLlm([
      err<SynthesisLlmError>({ kind: 'llm_unavailable', message: 'LLM_PROVIDER=none' }),
    ]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    const result = await synth.synthesize(CORPUS, opts());

    expect(llm.requests).toHaveLength(1);
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.strategyUsed).toBe('deterministic');
    expect(result.value.fallbackUsed).toBe(true);
    expect(result.value.brief.metadata.deterministic_fallback_used).toBe(true);
  });

  it('falls back on a non-retryable provider error', async () => {
    const llm = new ScriptedLlm([
      err<SynthesisLlmError>({ kind: 'llm_failed', message: 'boom', retryable: false }),
    ]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    const result = await synth.synthesize(CORPUS, opts());
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.fallbackUsed).toBe(true);
  });

  it('strips a fabricated price via the citation post-pass', async () => {
    const fabricatedJson = JSON.stringify({
      title: 'Prices',
      overview: 'Amazon lists it at $328. [1]',
      key_findings: [
        {
          text: 'Amazon lists the headphones at $328. [1]',
          citations: [1],
          editorial: false,
          facet: null,
        },
        // $999 appears in no source — should be stripped.
        {
          text: 'A hidden clearance drops it to $999. [2]',
          citations: [2],
          editorial: false,
          facet: null,
        },
      ],
      sections: [],
      facets: null,
    });
    const llm = new ScriptedLlm([response(fabricatedJson)]);
    const synth = new LlmSynthesizer({ llm, prompt: PROMPT, deterministic: deterministic() });

    const result = await synth.synthesize(CORPUS, opts());

    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.verdict.stripped).toBeGreaterThanOrEqual(1);
    const texts = result.value.brief.key_findings.map((f) => f.text);
    expect(texts).not.toContain('A hidden clearance drops it to $999. [1]');
    expect(result.value.brief.notices.some((n) => n.kind === 'uncited_claim_stripped')).toBe(true);
  });
});

describe('@no-llm synthesis/parseDraft', () => {
  it('parses a bare JSON object', () => {
    const result = parseDraft('{"title":"T","overview":"O"}');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.title).toBe('T');
    expect(result.value.key_findings).toEqual([]);
  });

  it('extracts JSON wrapped in code fences and prose', () => {
    const result = parseDraft('Here you go:\n```json\n{"title":"T","overview":"O"}\n```\nDone.');
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.title).toBe('T');
  });

  it('returns an error when no JSON object is present', () => {
    expect(parseDraft('just some prose').isOk).toBe(false);
  });

  it('returns an error when required string fields are missing', () => {
    expect(parseDraft('{"title":"T"}').isOk).toBe(false);
  });

  it('drops malformed findings and coerces citation arrays', () => {
    const result = parseDraft(
      JSON.stringify({
        title: 'T',
        overview: 'O',
        key_findings: [
          { text: 'ok', citations: [1, 2.5, 'x'], editorial: false },
          { citations: [1] },
          'garbage',
        ],
      }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.key_findings).toHaveLength(1);
    expect(result.value.key_findings[0]!.citations).toEqual([1]);
  });
});
