/** @no-llm Smoke tests verifying the supported agent barrel exports. */
import { describe, expect, it } from 'vitest';

import { AgentAuthUnavailableError, exitCodeForAgenticOutcome } from '../src/index.js';

describe('@yantra/agent barrel exports', () => {
  it('exports typed startup errors', () => {
    const error = new AgentAuthUnavailableError(
      'anthropic',
      'environment',
      'Set ANTHROPIC_API_KEY.',
    );
    expect(error.toAgentError().code).toBe('AGENT_AUTH_UNAVAILABLE');
  });

  it('exports runtime outcome helpers', () => {
    const outcome = {
      kind: 'published',
      runId: 'r',
      runDir: '/runs/r',
      brief: {
        kind: 'brief',
        briefId: 'b',
        jsonPath: 'brief.json',
        markdownPath: 'brief.md',
        htmlPath: 'brief.html',
      },
      taskOutcome: 'fulfilled',
      requirements: null,
      artifacts: [],
      captureSets: [],
      terminationReason: 'model_finished',
    } as const;
    expect(exitCodeForAgenticOutcome(outcome)).toBe(0);
    expect(exitCodeForAgenticOutcome({ ...outcome, taskOutcome: 'partial' })).toBe(2);
  });
});
