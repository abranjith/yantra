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
    expect(
      exitCodeForAgenticOutcome({
        kind: 'published',
        brief: { jsonPath: 'brief.json', markdownPath: 'brief.md', htmlPath: 'brief.html' },
      }),
    ).toBe(0);
  });
});
