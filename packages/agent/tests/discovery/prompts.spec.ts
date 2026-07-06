import { describe, expect, it } from 'vitest';

import { DISCOVERY_PROMPT, type DiscoveryPromptCycle } from '../../src/discovery/prompts.js';

describe('@no-llm DISCOVERY_PROMPT', () => {
  it('states the hard rules: max 3 steps, forced confirmation, no secrets, honest blocks', () => {
    expect(DISCOVERY_PROMPT.system).toContain('at most 3 steps');
    expect(DISCOVERY_PROMPT.system).toContain('automatically paused for human');
    expect(DISCOVERY_PROMPT.system).toContain('NO access to secrets');
    expect(DISCOVERY_PROMPT.system).toContain('do NOT try to evade');
  });

  it('documents the intent-only locator shape and rejects other kinds by omission', () => {
    expect(DISCOVERY_PROMPT.system).toContain('"kind": "intent"');
    expect(DISCOVERY_PROMPT.system).not.toContain('"kind": "css"');
    expect(DISCOVERY_PROMPT.system).not.toContain('"kind": "recorded"');
    expect(DISCOVERY_PROMPT.system).not.toContain('"kind": "workflow"');
  });

  it('lists only the single-cycle-appropriate step verbs (no branch/loop/call_workflow)', () => {
    for (const verb of ['navigate', 'click', 'fill', 'extract', 'wait_for', 'assert']) {
      expect(DISCOVERY_PROMPT.system).toContain(`### ${verb}`);
    }
    for (const verb of ['branch', 'loop', 'call_workflow', 'llm_summarize']) {
      expect(DISCOVERY_PROMPT.system).not.toContain(`### ${verb}`);
    }
  });

  describe('buildUser', () => {
    it('renders the goal, allowlist, and a first-turn placeholder with no history', () => {
      const user = DISCOVERY_PROMPT.buildUser({
        goal: 'find concert tickets',
        hostAllowlist: ['example.com'],
        history: [],
      });
      expect(user).toContain('GOAL: find concert tickets');
      expect(user).toContain('ALLOWED HOSTS: example.com');
      expect(user).toContain('no cycles yet');
    });

    it('renders full-detail cycles with rationale, steps, outcome, and interactables', () => {
      const cycle: DiscoveryPromptCycle = {
        kind: 'full',
        index: 0,
        rationale: 'start by navigating to the site',
        stepsDescription: 'navigate',
        observationDigest: 'Welcome to Example',
        interactablesDescription: 'button "Search"',
        stepOutcome: 'completed',
      };
      const user = DISCOVERY_PROMPT.buildUser({
        goal: 'g',
        hostAllowlist: ['example.com'],
        history: [cycle],
      });
      expect(user).toContain('rationale: start by navigating to the site');
      expect(user).toContain('outcome: completed');
      expect(user).toContain('page: Welcome to Example');
      expect(user).toContain('interactables: button "Search"');
    });

    it('renders one-line cycles compactly', () => {
      const cycle: DiscoveryPromptCycle = {
        kind: 'one_line',
        index: 3,
        summary: 'click -> completed @ https://example.com/results',
      };
      const user = DISCOVERY_PROMPT.buildUser({ goal: 'g', hostAllowlist: [], history: [cycle] });
      expect(user).toContain('[cycle 3] click -> completed @ https://example.com/results');
    });

    it('renders a full cycle with a null observationDigest as "(not reached)"', () => {
      const cycle: DiscoveryPromptCycle = {
        kind: 'full',
        index: 1,
        rationale: 'r',
        stepsDescription: 'click',
        observationDigest: null,
        interactablesDescription: '(none)',
        stepOutcome: 'rejected',
      };
      const user = DISCOVERY_PROMPT.buildUser({ goal: 'g', hostAllowlist: [], history: [cycle] });
      expect(user).toContain('page: (not reached)');
    });
  });

  describe('buildReprompt', () => {
    it('lists each issue as a bullet and instructs a complete re-emit', () => {
      const reprompt = DISCOVERY_PROMPT.buildReprompt(['steps/0/locator: only intent allowed']);
      expect(reprompt).toContain('failed validation');
      expect(reprompt).toContain('- steps/0/locator: only intent allowed');
      expect(reprompt).toContain('COMPLETE corrected JSON');
    });

    it('handles an empty issues array without throwing', () => {
      expect(() => DISCOVERY_PROMPT.buildReprompt([])).not.toThrow();
    });
  });
});
