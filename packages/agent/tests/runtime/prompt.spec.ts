import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PayloadSanitizer } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  AGENT_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildAgentUserPrompt,
  type AgentAmbientContext,
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
    expect(PROMPT_VERSION).toBe('agent-v3');
  });

  it('keeps the completion section flow-neutral but anti-stall (agent-v3)', () => {
    // Regression: small local models given a broad goal (for example, "FIFA
    // World Cup") asked the user for clarification and stalled until
    // AGENT_COMPLETION_MISSING — so the anti-stall rule must stay. But the
    // system prompt is shared by attended and unattended runs, so it must NOT
    // assert "no user exists"; that flow-specific fact lives in the per-run
    // interaction line instead.
    const completionSection = AGENT_SYSTEM_PROMPT.split('## Completion and failure')[1] ?? '';

    expect(completionSection).toMatch(/do not stall/i);
    expect(completionSection).toMatch(/most reasonable interpretation/i);
    expect(completionSection).not.toMatch(/no user is available/i);
    expect(completionSection).toMatch(/interaction line/i);
  });

  it('states the unattended no-clarification rule in an unattended per-run prompt (default)', () => {
    // Small local models weight the user prompt most heavily, so the rule is
    // also a fixed line of the assembled prompt. Unattended is the default.
    const prompt = buildAgentUserPrompt({ goal: 'FIFA World Cup', budgets }, markerSanitizer);

    expect(prompt).toMatch(/unattended run/i);
    expect(prompt).toMatch(/never ask for clarification/i);
    expect(prompt).toMatch(/most reasonable interpretation/i);
  });

  it('states the interactive interaction line when the run is attended', () => {
    // For an interactive `do` run a user IS present for consent, so the prompt
    // must not claim "no user"; it may not ask open-ended questions either, and
    // the anti-stall rule is preserved.
    const prompt = buildAgentUserPrompt(
      { goal: 'log in and check the balance', budgets, attended: true },
      markerSanitizer,
    );

    expect(prompt).toMatch(/interactive run/i);
    expect(prompt).toMatch(/approve protected actions/i);
    expect(prompt).toMatch(/most reasonable interpretation/i);
    expect(prompt).not.toMatch(/unattended run/i);
    expect(prompt).not.toMatch(/no user can answer questions/i);
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

  it('renders an unbounded wall clock as "unlimited", never as Infinity', () => {
    const prompt = buildAgentUserPrompt(
      { goal: 'g', budgets: { ...budgets, wallClockMs: Number.POSITIVE_INFINITY } },
      markerSanitizer,
    );

    expect(prompt).toContain('- wall clock: unlimited');
    expect(prompt).not.toContain('Infinity');
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

  it('renders the ambient block as authoritative with weekday, ISO date, offset, and locale', () => {
    // Regression: without an injected date, small local models answered
    // "current date" style goals from their training prior. The block must be
    // framed as overriding training data or small models "correct" it back.
    const ambient: AgentAmbientContext = {
      now: new Date('2026-07-19T12:00:00Z'),
      timeZone: 'America/Chicago',
      locale: 'en-US',
    };

    const prompt = buildAgentUserPrompt({ goal: 'g', budgets, ambient }, markerSanitizer);

    expect(prompt).toContain(
      'Ambient context (authoritative; prefer these values over your training data):',
    );
    expect(prompt).toContain('- current date: Sunday, 2026-07-19');
    expect(prompt).toContain('- timezone: America/Chicago (UTC-05:00)');
    expect(prompt).toContain('- locale: en-US');
    // Primacy for small models: goal first, ambient facts before constraints.
    expect(prompt.indexOf('Goal:')).toBeLessThan(prompt.indexOf('Ambient context'));
    expect(prompt.indexOf('Ambient context')).toBeLessThan(prompt.indexOf('Run constraints:'));
  });

  it('derives the calendar date and weekday in the requested zone, not UTC', () => {
    // 2026-07-19T03:00:00Z is still Saturday July 18 in Los Angeles but
    // already Sunday July 19 in Tokyo.
    const now = new Date('2026-07-19T03:00:00Z');

    const losAngeles = buildAgentUserPrompt(
      { goal: 'g', budgets, ambient: { now, timeZone: 'America/Los_Angeles', locale: 'en-US' } },
      markerSanitizer,
    );
    const tokyo = buildAgentUserPrompt(
      { goal: 'g', budgets, ambient: { now, timeZone: 'Asia/Tokyo', locale: 'ja-JP' } },
      markerSanitizer,
    );

    expect(losAngeles).toContain('- current date: Saturday, 2026-07-18');
    expect(losAngeles).toContain('- timezone: America/Los_Angeles (UTC-07:00)');
    expect(tokyo).toContain('- current date: Sunday, 2026-07-19');
    expect(tokyo).toContain('- timezone: Asia/Tokyo (UTC+09:00)');
    expect(tokyo).toContain('- locale: ja-JP');
  });

  it('reports the DST-correct offset for the run instant', () => {
    const winter = buildAgentUserPrompt(
      {
        goal: 'g',
        budgets,
        ambient: {
          now: new Date('2026-01-19T12:00:00Z'),
          timeZone: 'America/Chicago',
          locale: 'en-US',
        },
      },
      markerSanitizer,
    );

    expect(winter).toContain('- timezone: America/Chicago (UTC-06:00)');
  });

  it('renders the UTC zone with an explicit +00:00 offset', () => {
    const prompt = buildAgentUserPrompt(
      {
        goal: 'g',
        budgets,
        ambient: { now: new Date('2026-07-19T12:00:00Z'), timeZone: 'UTC', locale: 'en-US' },
      },
      markerSanitizer,
    );

    expect(prompt).toContain('- timezone: UTC (UTC+00:00)');
  });

  it('falls back to the host timezone and locale when only the clock is given', () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();

    const prompt = buildAgentUserPrompt(
      { goal: 'g', budgets, ambient: { now: new Date('2026-07-19T12:00:00Z') } },
      markerSanitizer,
    );

    expect(prompt).toContain(`- timezone: ${resolved.timeZone} (UTC`);
    expect(prompt).toContain(`- locale: ${resolved.locale}`);
  });

  it('omits the ambient block entirely when no ambient context is provided', () => {
    const prompt = buildAgentUserPrompt({ goal: 'g', budgets }, markerSanitizer);

    expect(prompt).not.toContain('Ambient context');
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
