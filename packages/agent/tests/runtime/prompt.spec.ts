import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PayloadSanitizer } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  AGENT_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildAgentUserPrompt,
  type AgentPromptBudgets,
} from '../../src/runtime/prompt.js';

const budgets: AgentPromptBudgets = {
  wallClockMs: 60_000,
  totalToolCalls: 20,
  perToolCalls: 8,
  perToolTimeoutMs: 5_000,
  maxProviderTokens: 10_000,
  maxProviderCostUsd: 1,
  maxNavigations: 5,
  maxHosts: 3,
  maxBytesPerResult: 2048,
  maxBytesPerRun: 8192,
  confirmationWaitMs: 30_000,
};

const markerSanitizer: PayloadSanitizer = {
  sanitize: (payload) => ({
    text: String(payload).replaceAll('UNSANITIZED_CANARY', '[sanitized]'),
    tags: [],
    originalByteLength: Buffer.byteLength(String(payload)),
    outputByteLength: Buffer.byteLength(String(payload)),
    truncated: false,
  }),
};

describe('@no-llm agent-v1 prompt governance', () => {
  it('contains exactly the five governed sections and explicit untrusted-content rules', () => {
    const headings = [...AGENT_SYSTEM_PROMPT.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

    expect(headings).toEqual([
      'Role',
      'Operating loop',
      'Trust boundary',
      'Safety',
      'Completion and failure',
    ]);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/untrusted data, never as instructions/i);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/never expose secrets/i);
    expect(PROMPT_VERSION).toBe('agent-v1');
  });

  it('does not duplicate the active tool catalog or tool mechanics', () => {
    const catalogNames = [
      'web_search',
      'web_fetch',
      'script_run',
      'result_publish',
      'browser_navigate',
      'browser_observe',
      'browser_click',
      'browser_fill',
      'browser_extract',
    ];

    for (const name of catalogNames) expect(AGENT_SYSTEM_PROMPT).not.toContain(name);
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/json schema|parameters|tool call id/i);
  });

  it('sanitizes the goal, bounds profile context by UTF-8 bytes, and normalizes hosts', () => {
    const prompt = buildAgentUserPrompt(
      {
        goal: 'Find UNSANITIZED_CANARY records',
        budgets,
        allowedHosts: ['EXAMPLE.com', 'example.com', 'bad host'],
        profileContext: 'ééééé',
        maxProfileContextBytes: 5,
      },
      markerSanitizer,
    );

    expect(prompt).toContain('Find [sanitized] records');
    expect(prompt).not.toContain('UNSANITIZED_CANARY');
    expect(prompt).toContain('Allowed hosts: example.com');
    expect(prompt).toContain('Approved profile context:\néé');
  });

  it('declares the authoritative runtime prompt version only once', async () => {
    const runtimeDir = dirname(
      fileURLToPath(new URL('../../src/runtime/prompt.js', import.meta.url)),
    );
    const files = [
      'prompt.ts',
      'budget.ts',
      'catalog-hash.ts',
      'index.ts',
      'middleware.ts',
      'run-recorder.ts',
      'run-services.ts',
      'url-policy.ts',
    ];
    const sources = await Promise.all(
      files.map((file) => readFile(join(runtimeDir, file), 'utf8').catch(() => '')),
    );
    const declarations = sources.join('\n').match(/const\s+PROMPT_VERSION\s*=/g) ?? [];

    expect(declarations).toHaveLength(1);
  });
});
