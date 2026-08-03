/**
 * @no-llm Personalization privacy property test (plan §9, FEAT-018 TASK-005).
 *
 * The structural guarantee: **raw run-history text never reaches an LLM
 * payload.** This suite generates history rows with PII- and secret-shaped
 * intent texts, records them in a real `HistoryStore`, enables personalization,
 * then drives the LLM synthesizer (the primary LLM-payload assembler that
 * receives the personalization context) through a spy port that captures every
 * `send()` payload. It asserts no generated history string ever appears in any
 * captured system/user payload — mirroring the secrets-not-in-JSONata invariant.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SqliteHistoryStore } from '../../src/index-db/history-store.js';
import { runMigrations } from '../../src/index-db/migrations.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';
import type {
  EffectivePreference,
  EffectivePreferences,
} from '../../src/profile/effective-preferences.js';
import { buildPersonalizationContext } from '../../src/profile/personalization.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';
import { LlmSynthesizer } from '../../src/synthesis/llm.js';
import type {
  SynthesisDoc,
  SynthesisLlm,
  SynthesisLlmRequest,
  SynthesisPromptInput,
  SynthesisPromptTemplate,
} from '../../src/synthesis/types.js';

/** A spy LLM port that records every payload it is asked to send. */
class SpyLlm implements SynthesisLlm {
  public readonly providerId = 'spy';
  public readonly payloads: SynthesisLlmRequest[] = [];

  public async send(request: SynthesisLlmRequest): ReturnType<SynthesisLlm['send']> {
    this.payloads.push(request);
    // Return a minimal valid Brief draft so synthesis proceeds down the LLM path.
    return {
      isOk: true as const,
      value: {
        text: JSON.stringify({
          title: 'Result',
          overview: 'An answer. [1]',
          key_findings: [{ text: 'A finding. [1]', citations: [1], editorial: false, facet: null }],
          sections: [],
          facets: null,
        }),
        usage: null,
      },
    };
  }
}

/** A prompt template that echoes personalization + sources into the user payload. */
const promptTemplate: SynthesisPromptTemplate = {
  system: 'You are a synthesizer.',
  buildUser(inputPrompt: SynthesisPromptInput): string {
    const sources = inputPrompt.sources
      .map((s) => `SOURCE [${s.n}] ${s.host}: ${s.text}`)
      .join('\n');
    return [
      `QUERY: ${inputPrompt.query}`,
      inputPrompt.personalization ? `USER: ${inputPrompt.personalization}` : '',
      sources,
    ].join('\n');
  },
  buildReprompt(issues) {
    return `FIX: ${issues.map((i) => i.message).join('; ')}`;
  },
};

/** Approved preferences (never derived from history). */
function approvedPrefs(units: string, retailers: readonly string[]): EffectivePreferences {
  const map = new Map<string, EffectivePreference>();
  map.set('locale.units', {
    key: 'locale.units',
    value: units,
    source: 'user',
    approved: true,
    provenance: 'profile.yaml',
  });
  map.set('personalization.favorite_retailers', {
    key: 'personalization.favorite_retailers',
    value: [...retailers],
    source: 'user',
    approved: true,
    provenance: 'profile.yaml',
  });
  return map;
}

function makeDoc(text: string): SynthesisDoc {
  return {
    url: 'https://example.com/a',
    finalUrl: null,
    host: 'example.com',
    title: 'Example',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    publishedAt: null,
    text,
    excerpt: null,
  };
}

describe('@no-llm personalization never leaks history into LLM payloads', () => {
  it('never includes operational agent preferences even when approved', () => {
    const prefs = new Map(approvedPrefs('metric', ['Target']));
    const agentValues: Readonly<Record<string, unknown>> = {
      'agent.provider': 'private-provider-canary',
      'agent.model': 'private-model-canary',
      'agent.thinking': 'private-thinking-canary',
      'agent.max_duration': '20m',
      'agent.max_tokens': 1234567,
      'agent.tool_timeout': '4m',
      'agent.tool_retries': 9,
      'agent.confirm_timeout': '5m',
    };
    for (const [key, value] of Object.entries(agentValues)) {
      prefs.set(key, {
        key,
        value,
        source: 'user',
        approved: true,
        provenance: 'profile.yaml',
      });
    }

    const result = buildPersonalizationContext(prefs);
    expect(result.isOk).toBe(true);
    if (!result.isOk || result.value === null) throw new Error('expected personalization context');
    const context = String(result.value);
    expect(context).toContain('Prefers metric units.');
    expect(context).toContain('Favors retailers: Target.');
    for (const value of Object.values(agentValues)) {
      expect(context).not.toContain(String(value));
    }
  });

  it('captures no history intent text in any LLM payload (500 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Secret/PII-shaped history intent texts — the strings that must never leak.
        fc.array(
          fc.oneof(
            fc.constant('sk-SECRET0123456789abcdefzzzz'),
            fc.constant('my ssn is 123-45-6789'),
            fc.constant('password hunter2 for bank login'),
            fc.string({ minLength: 3, maxLength: 40 }).map((s) => `private-query-${s}`),
          ),
          { minLength: 1, maxLength: 5 },
        ),
        fc.constantFrom('metric', 'imperial'),
        fc.array(fc.constantFrom('Amazon', 'BestBuy', 'Target'), { maxLength: 3 }),
        async (historyIntents, units, retailers) => {
          const db = new DatabaseSync(':memory:');
          runMigrations(db);
          const historyStore = new SqliteHistoryStore({ db });

          // Record the secret-shaped intents as real history rows.
          for (let i = 0; i < historyIntents.length; i += 1) {
            await historyStore.record({
              runId: `run-${i}`,
              taskType: 'ask',
              intentText: historyIntents[i]!,
              briefId: null,
              status: 'succeeded',
              startedAt: '2026-07-01T00:00:00.000Z',
              finishedAt: null,
              durationMs: null,
              costUsd: null,
              provider: null,
            });
          }

          // Build the personalization context from PREFERENCES ONLY.
          const ctx = buildPersonalizationContext(approvedPrefs(units, retailers));
          const personalization = ctx.isOk && ctx.value !== null ? ctx.value : undefined;

          const spy = new SpyLlm();
          const synth = new LlmSynthesizer({
            llm: spy,
            prompt: promptTemplate,
            deterministic: new DeterministicSynthesizer(),
          });

          await synth.synthesize(
            { query: 'best headphones', docs: [makeDoc('Headphones cost $199.')], failures: [] },
            {
              strategy: 'llm',
              detail: 'full',
              length: 'medium',
              scope: 'public',
              taskId: '01J000000000000000000TASK',
              runId: 'run-x',
              searchProvider: 'tavily',
              ...(personalization ? { personalization } : {}),
            },
          );

          db.close();

          // The spy MUST have been called, and NO history intent may appear anywhere.
          expect(spy.payloads.length).toBeGreaterThan(0);
          for (const payload of spy.payloads) {
            const blob = `${payload.system}\n${payload.user}`;
            for (const intent of historyIntents) {
              expect(blob.includes(intent)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
