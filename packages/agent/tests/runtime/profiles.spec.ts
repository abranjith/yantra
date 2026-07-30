import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { yantraToolCatalog } from '../../src/adapters/pi/tools/index.js';
import { DEFAULT_BUDGET_LIMITS } from '../../src/runtime/budget.js';
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

  it('steers the web-facing commands toward the evidence-in-one-call flow', () => {
    // ask/research must tell the model web_search now returns fetched content so
    // it stops chaining web_fetch calls after every search (FEAT-WI-001 TASK-004).
    for (const command of ['ask', 'research'] as const) {
      const addendum = COMMAND_TASK_PROFILES[command].promptAddendum;
      expect(addendum).toMatch(/web_search/);
      expect(addendum).toMatch(/content|fetched|evidence/i);
      expect(addendum).toMatch(/web_fetch/);
    }
  });

  it('retunes caps for the combined tool while preserving ask < research < do', () => {
    // One combined web_search replaces ~1 search + 2–3 fetches, so the per-command
    // call budgets drop (FEAT-WI-001 TASK-005); `do` keeps the global defaults.
    expect(COMMAND_TASK_PROFILES.ask.budgets).toMatchObject({
      totalToolCalls: 12,
      perToolCalls: 6,
    });
    expect(COMMAND_TASK_PROFILES.research.budgets).toMatchObject({
      totalToolCalls: 30,
      perToolCalls: 12,
    });
    expect(COMMAND_TASK_PROFILES.do.budgets.totalToolCalls).toBeUndefined();
    expect(COMMAND_TASK_PROFILES.do.budgets.perToolCalls).toBeUndefined();

    // Ordering invariant: ask < research < do (do falls back to global defaults).
    const doTotal = DEFAULT_BUDGET_LIMITS.totalToolCalls;
    const doPerTool = DEFAULT_BUDGET_LIMITS.perToolCalls;
    expect(COMMAND_TASK_PROFILES.ask.budgets.totalToolCalls!).toBeLessThan(
      COMMAND_TASK_PROFILES.research.budgets.totalToolCalls!,
    );
    expect(COMMAND_TASK_PROFILES.research.budgets.totalToolCalls!).toBeLessThan(doTotal);
    expect(COMMAND_TASK_PROFILES.ask.budgets.perToolCalls!).toBeLessThan(
      COMMAND_TASK_PROFILES.research.budgets.perToolCalls!,
    );
    expect(COMMAND_TASK_PROFILES.research.budgets.perToolCalls!).toBeLessThan(doPerTool);
  });

  it('still lets env overrides win over the retuned defaults', () => {
    const configured = resolveCommandTaskProfile('research', {
      YANTRA_AGENT_RESEARCH_MAX_TOOL_CALLS: '40',
      YANTRA_AGENT_RESEARCH_MAX_CALLS_PER_TOOL: '18',
    });
    expect(configured.budgets).toMatchObject({ totalToolCalls: 40, perToolCalls: 18 });
  });

  it('keeps the superseded research prompt stack removed', () => {
    expect(existsSync(new URL('../../src/research/prompt.ts', import.meta.url))).toBe(false);
  });

  it('keeps src/synthesis/prompt.ts an injected template, not a prompt stack', () => {
    // FEAT-FP-001 reinstated this file deliberately: it is the concrete
    // `SynthesisPromptTemplate` core declares as a port and `apps/cli` injects
    // as data. That is the opposite of the removed ask/research prompt stacks,
    // which assembled task-shaped prompts inside the agent package. The
    // narrower assertions below encode the distinction the old absence check
    // was standing in for.
    const promptUrl = new URL('../../src/synthesis/prompt.ts', import.meta.url);
    expect(existsSync(promptUrl)).toBe(true);

    const source = readFileSync(promptUrl, 'utf8');
    expect(source).not.toMatch(/from\s+['"]@yantra\/core/);
    expect(source).toContain('YANTRA_SYNTHESIS_PROMPT');
  });
});
