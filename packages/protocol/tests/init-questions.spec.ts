import { describe, expect, it } from 'vitest';

import {
  INIT_QUESTIONS,
  InitAnswersRequest,
  InitQuestion,
  evaluateWhen,
  resolveQuestionInitial,
  resolveQuestionMessage,
  type InitQuestionId,
  type InitQuestionWhen,
} from '../src/index.js';

function referencedQuestionIds(when: InitQuestionWhen | null): InitQuestionId[] {
  if (!when) return [];
  if (when.op === 'and') {
    return when.conditions.flatMap((c) => referencedQuestionIds(c));
  }
  return [when.question];
}

describe('@no-llm init question catalog', () => {
  it('validates every catalog entry against InitQuestion and has unique IDs', () => {
    const seen = new Set<string>();
    for (const question of INIT_QUESTIONS) {
      expect(() => InitQuestion.parse(question)).not.toThrow();
      expect(seen.has(question.id)).toBe(false);
      seen.add(question.id);
    }
    expect(seen.size).toBe(INIT_QUESTIONS.length);
  });

  it('references only earlier question IDs in every `when` condition (acyclic)', () => {
    const indexById = new Map<InitQuestionId, number>(INIT_QUESTIONS.map((q, i) => [q.id, i]));
    for (let i = 0; i < INIT_QUESTIONS.length; i++) {
      const q = INIT_QUESTIONS[i]!;
      for (const ref of referencedQuestionIds(q.when)) {
        const refIndex = indexById.get(ref);
        expect(refIndex).toBeDefined();
        expect(refIndex!).toBeLessThan(i);
      }
      if (q.initialBy) {
        const refIndex = indexById.get(q.initialBy.question);
        expect(refIndex).toBeDefined();
        expect(refIndex!).toBeLessThan(i);
      }
    }
  });

  it('gives every select question non-empty choices and non-select questions null choices', () => {
    for (const q of INIT_QUESTIONS) {
      if (q.kind === 'select') {
        expect(Array.isArray(q.choices)).toBe(true);
        expect(q.choices!.length).toBeGreaterThan(0);
      } else {
        expect(q.choices).toBeNull();
      }
    }
  });

  it('evaluates `when` truth table for provider and context branches', () => {
    const byId = new Map(INIT_QUESTIONS.map((q) => [q.id, q]));

    // provider: 'none' skips credential and model questions, keeps search/storage/context
    const noneAnswers = { provider: 'none' } as const;
    expect(evaluateWhen(byId.get('credential_source')!, noneAnswers)).toBe(false);
    expect(evaluateWhen(byId.get('credential_env_name')!, noneAnswers)).toBe(false);
    expect(evaluateWhen(byId.get('credential_secret')!, noneAnswers)).toBe(false);
    expect(evaluateWhen(byId.get('model_id')!, noneAnswers)).toBe(false);
    expect(evaluateWhen(byId.get('ollama_base_url')!, noneAnswers)).toBe(false);
    expect(evaluateWhen(byId.get('search_key_provider')!, noneAnswers)).toBe(true);
    expect(evaluateWhen(byId.get('data_dir')!, noneAnswers)).toBe(true);
    expect(evaluateWhen(byId.get('context_location')!, noneAnswers)).toBe(true);

    // provider: 'anthropic' + env vs keychain
    expect(evaluateWhen(byId.get('credential_source')!, { provider: 'anthropic' })).toBe(true);
    expect(
      evaluateWhen(byId.get('credential_env_name')!, {
        provider: 'anthropic',
        credential_source: 'environment variable',
      }),
    ).toBe(true);
    expect(
      evaluateWhen(byId.get('credential_secret')!, {
        provider: 'anthropic',
        credential_source: 'environment variable',
      }),
    ).toBe(false);
    expect(
      evaluateWhen(byId.get('credential_secret')!, {
        provider: 'anthropic',
        credential_source: 'keychain',
      }),
    ).toBe(true);
    expect(evaluateWhen(byId.get('ollama_base_url')!, { provider: 'anthropic' })).toBe(false);

    // provider: 'ollama' includes ollama_base_url
    expect(evaluateWhen(byId.get('ollama_base_url')!, { provider: 'ollama' })).toBe(true);

    // search_key_provider
    expect(evaluateWhen(byId.get('search_key_secret')!, { search_key_provider: 'skip' })).toBe(
      false,
    );
    expect(evaluateWhen(byId.get('search_key_secret')!, { search_key_provider: 'tavily' })).toBe(
      true,
    );
    expect(evaluateWhen(byId.get('search_key_secret')!, { search_key_provider: 'brave' })).toBe(
      true,
    );

    // context_location false skips context_city; true includes it
    expect(evaluateWhen(byId.get('context_city')!, { context_location: false })).toBe(false);
    expect(evaluateWhen(byId.get('context_city')!, { context_location: null })).toBe(false);
    expect(evaluateWhen(byId.get('context_city')!, { context_location: true })).toBe(true);
  });

  it('resolves dynamic prompt messages and literal initial values', () => {
    const byId = new Map(INIT_QUESTIONS.map((q) => [q.id, q]));
    expect(resolveQuestionMessage(byId.get('credential_secret')!, { provider: 'anthropic' })).toBe(
      'Secret value for anthropic.api_key',
    );
    expect(
      resolveQuestionMessage(byId.get('search_key_secret')!, { search_key_provider: 'tavily' }),
    ).toBe('Secret value for tavily.api_key');

    expect(
      resolveQuestionInitial(byId.get('credential_env_name')!, { provider: 'anthropic' }),
    ).toBe('ANTHROPIC_API_KEY');
    expect(resolveQuestionInitial(byId.get('credential_env_name')!, { provider: 'ollama' })).toBe(
      'OLLAMA_API_KEY',
    );
    expect(resolveQuestionInitial(byId.get('model_id')!, { provider: 'anthropic' })).toBe(
      'claude-opus-4-7',
    );
    expect(resolveQuestionInitial(byId.get('model_id')!, { provider: 'ollama' })).toBe(
      'llama3.1:8b',
    );
  });

  it('rejects secret-kind IDs and unknown keys inside InitAnswersRequest.answers', () => {
    const valid = InitAnswersRequest.safeParse({
      answers: {
        provider: 'anthropic',
        credential_source: 'keychain',
        model_id: 'claude-opus-4-7',
        search_key_provider: 'skip',
        data_dir: null,
        context_location: true,
        context_city: null,
      },
      secrets: {
        credential_secret: 'sk-ant-test',
      },
      invocation_id: 'inv-1',
    });
    expect(valid.success).toBe(true);

    const secretInAnswers = InitAnswersRequest.safeParse({
      answers: {
        provider: 'anthropic',
        credential_secret: 'CANARY-secret-in-wrong-half',
      },
      secrets: {},
      invocation_id: 'inv-2',
    });
    expect(secretInAnswers.success).toBe(false);

    const searchSecretInAnswers = InitAnswersRequest.safeParse({
      answers: {
        search_key_provider: 'tavily',
        search_key_secret: 'CANARY-search-secret',
      },
      secrets: {},
      invocation_id: 'inv-3',
    });
    expect(searchSecretInAnswers.success).toBe(false);

    const unknownKey = InitAnswersRequest.safeParse({
      answers: {
        unknown_question: 'foo',
      },
      secrets: {},
      invocation_id: 'inv-4',
    });
    expect(unknownKey.success).toBe(false);
  });
});
