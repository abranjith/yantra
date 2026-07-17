import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { yantraToolCatalog } from '../../src/adapters/pi/tools/index.js';
import { hashToolCatalog } from '../../src/runtime/catalog-hash.js';
import { COMMAND_TASK_PROFILES, resolveCommandTaskProfile } from '../../src/runtime/profiles.js';
import { buildServices } from '../adapters/pi/tools/test-support.js';

describe('@no-llm command task profiles', () => {
  it('registers exactly the declared least-privilege catalog for each command', () => {
    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      expect(yantraToolCatalog(buildServices(), profile).map((tool) => tool.name)).toEqual(
        [...profile.toolNames].sort(),
      );
    }
  });

  it('uses stable per-profile catalog hashes and distinct capabilities', () => {
    const services = buildServices();
    const ask = hashToolCatalog(yantraToolCatalog(services, COMMAND_TASK_PROFILES.ask));
    const askAgain = hashToolCatalog(yantraToolCatalog(services, COMMAND_TASK_PROFILES.ask));
    const research = hashToolCatalog(yantraToolCatalog(services, COMMAND_TASK_PROFILES.research));
    const task = hashToolCatalog(yantraToolCatalog(services, COMMAND_TASK_PROFILES.do));

    expect(ask).toBe(askAgain);
    expect(new Set([ask, research, task]).size).toBe(3);
  });

  it('does not time-bound any command by default; wall clock is an explicit override', () => {
    // Unlimited-by-default: local models are slow, so a fixed deadline aborts
    // legitimate runs. Bounding is opt-in via env/CLI (see budget.ts).
    expect(COMMAND_TASK_PROFILES.ask.budgets.wallClockMs).toBeUndefined();
    expect(COMMAND_TASK_PROFILES.research.budgets.wallClockMs).toBeUndefined();
    expect(COMMAND_TASK_PROFILES.do.budgets.wallClockMs).toBeUndefined();
  });

  it('reads per-command budget configuration with sane profile fallbacks', () => {
    const configured = resolveCommandTaskProfile('ask', {
      YANTRA_AGENT_ASK_BUDGET_MS: '90000',
      YANTRA_AGENT_ASK_MAX_TOOL_CALLS: '9',
      YANTRA_AGENT_ASK_MAX_CALLS_PER_TOOL: '4',
    });
    const fallback = resolveCommandTaskProfile('ask', { YANTRA_AGENT_ASK_BUDGET_MS: '-2' });

    expect(configured.budgets).toMatchObject({
      wallClockMs: 90_000,
      totalToolCalls: 9,
      perToolCalls: 4,
    });
    expect(fallback.budgets).toMatchObject(COMMAND_TASK_PROFILES.ask.budgets);
  });

  it('keeps do equivalent to the full FEAT-026 catalog and enables research browsing only explicitly', () => {
    const full = yantraToolCatalog(buildServices()).map((tool) => tool.name);
    const task = yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do).map(
      (tool) => tool.name,
    );
    const research = resolveCommandTaskProfile('research', { YANTRA_AGENT_RESEARCH_BROWSE: '1' });

    expect(task).toEqual(full);
    expect(research.toolNames).toContain('browser_navigate');
    expect(research.toolNames).not.toContain('browser_click');
    expect(research.toolNames).not.toContain('browser_fill');
  });

  it('keeps command addenda free of tool schemas and completion remains in the one system prompt', () => {
    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      expect(profile.promptAddendum).not.toMatch(/\b(schema|typebox|parameters)\b/i);
      expect(profile.promptAddendum).toMatch(/publish/i);
    }
  });

  it('removes the superseded ask and research prompt stacks', () => {
    expect(existsSync(new URL('../../src/synthesis/prompt.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/research/prompt.ts', import.meta.url))).toBe(false);
  });
});
