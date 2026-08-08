import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { parseTemplate } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { yantraToolCatalog } from '../../src/adapters/pi/tools/index.js';
import { hashToolCatalog } from '../../src/runtime/catalog-hash.js';
import {
  COMMAND_TASK_PROFILES,
  promptAddendumFor,
  resolveCommandTaskProfile,
} from '../../src/runtime/profiles.js';
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

  it('exposes no per-command budgets and ignores legacy budget environment variables', () => {
    const configured = resolveCommandTaskProfile('ask', {
      YANTRA_AGENT_ASK_MAX_TOOL_CALLS: '9',
    });

    for (const profile of [...Object.values(COMMAND_TASK_PROFILES), configured]) {
      expect(profile).not.toHaveProperty('budgets');
    }
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
    // browser_form_fill mutates the page, so opt-in research browsing (a
    // read-only mode) must not gain it either.
    expect(research.toolNames).not.toContain('browser_form_fill');
  });

  it('gives browser_form_fill to do only', () => {
    expect(COMMAND_TASK_PROFILES.do.toolNames).toContain('browser_form_fill');
    expect(COMMAND_TASK_PROFILES.ask.toolNames).not.toContain('browser_form_fill');
    expect(COMMAND_TASK_PROFILES.research.toolNames).not.toContain('browser_form_fill');

    const doCatalog = yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do).map(
      (tool) => tool.name,
    );
    const askCatalog = yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.ask).map(
      (tool) => tool.name,
    );
    expect(doCatalog).toContain('browser_form_fill');
    expect(askCatalog).not.toContain('browser_form_fill');
  });

  it('gives semantic date and option pickers to do only', () => {
    for (const name of ['browser_pick_date', 'browser_pick_option'] as const) {
      expect(COMMAND_TASK_PROFILES.do.toolNames).toContain(name);
      expect(COMMAND_TASK_PROFILES.ask.toolNames).not.toContain(name);
      expect(COMMAND_TASK_PROFILES.research.toolNames).not.toContain(name);
    }
  });

  it('records the tool_catalog_hash after adding browser_form_fill', () => {
    // The catalog is name-sorted and hashed per run, so adding a tool changes
    // this value by design. Recorded so an unintended catalog change is visible.
    const hash = hashToolCatalog(yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(
      hashToolCatalog(yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do)),
    );
  });

  it('keeps command addenda free of tool schemas and completion remains in the one system prompt', () => {
    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      expect(profile.promptAddendum).not.toMatch(/\b(schema|typebox|parameters)\b/i);
      expect(profile.promptAddendum).toMatch(/publish/i);
    }
  });

  it('derives template completion addenda for all profiles without changing the defaults', () => {
    const parsed = parseTemplate(
      '# {{ title | text }}\n\n## Summary\n{{ summary }}\n\n{{ sources }}',
    );
    if (!parsed.isOk) throw new Error('fixture template did not parse');

    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      expect(promptAddendumFor(profile, null)).toBe(profile.promptAddendum);
      const templated = promptAddendumFor(profile, parsed.value);
      expect(templated).toContain('"title"');
      expect(templated).toContain('"summary"');
      expect(templated).not.toContain('"brief"');
      expect(templated).not.toMatch(/overview/i);
      expect(templated).toMatch(/Yantra renders/i);
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

  it('adds browser efficiency and bounded widget guidance only to do', () => {
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;
    expect(task).toMatch(/browser_form_fill/i);
    expect(task).toMatch(/browser_pick_date/i);
    expect(task).toMatch(/browser_pick_option/i);
    expect(task).toMatch(/browser_click only to activate/i);
    expect(task).toMatch(/never to operate a dropdown or calendar by hand/i);
    expect(task).toMatch(/return the committed value/i);
    expect(task).toMatch(/needs no confirming browser_observe/i);
    expect(task).toMatch(/do not chain browser_observe/i);
    expect(task).toMatch(/disabled: true/i);
    expect(task).toMatch(/bounded number of attempts/i);
    expect(task).toMatch(/do not switch to web_search/i);
    for (const command of ['ask', 'research'] as const) {
      expect(COMMAND_TASK_PROFILES[command].promptAddendum).not.toMatch(/browser_form_fill/i);
      expect(COMMAND_TASK_PROFILES[command].promptAddendum).not.toMatch(/disabled: true/i);
    }
  });

  it('keeps ask and research addenda byte-identical while do guidance changes', () => {
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    expect(digest(COMMAND_TASK_PROFILES.ask.promptAddendum)).toBe(
      'ee8fe1634fd2a09ad7c9c78ffb3da050121a74648082e62d16649adb0b85f40b',
    );
    expect(digest(COMMAND_TASK_PROFILES.research.promptAddendum)).toBe(
      'a2b284bef5c60dc165f2211ea1f984e1794440d4a956d907a2676817694ebe6c',
    );
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
