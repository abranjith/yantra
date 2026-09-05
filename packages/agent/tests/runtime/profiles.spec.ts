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
    expect(research.toolNames).not.toContain('browser_fill_element');
    // browser_fill_form mutates the page, so opt-in research browsing (a
    // read-only mode) must not gain it either.
    expect(research.toolNames).not.toContain('browser_fill_form');
  });

  it('gives the unified fill tools to do only', () => {
    expect(COMMAND_TASK_PROFILES.do.toolNames).toContain('browser_fill_form');
    expect(COMMAND_TASK_PROFILES.do.toolNames).toContain('browser_fill_element');
    expect(COMMAND_TASK_PROFILES.ask.toolNames).not.toContain('browser_fill_form');
    expect(COMMAND_TASK_PROFILES.research.toolNames).not.toContain('browser_fill_form');

    const doCatalog = yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do).map(
      (tool) => tool.name,
    );
    const askCatalog = yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.ask).map(
      (tool) => tool.name,
    );
    expect(doCatalog).toContain('browser_fill_form');
    expect(doCatalog).toContain('browser_fill_element');
    expect(askCatalog).not.toContain('browser_fill_form');
  });

  it('records the tool_catalog_hash after replacing the fill surface', () => {
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
    expect(task).toMatch(/browser_fill_form/i);
    expect(task).toMatch(/browser_fill_element/i);
    expect(task).toMatch(/browser_click only to/i);
    expect(task).toMatch(/never to operate a field widget by hand/i);
    expect(task).toMatch(/return the committed value/i);
    expect(task).toMatch(/needs no confirming browser_observe/i);
    expect(task).toMatch(/do not chain browser_observe/i);
    expect(task).toMatch(/disabled: true/i);
    expect(task).toMatch(/bounded number of attempts/i);
    expect(task).toMatch(/do not switch to web_search/i);
    for (const command of ['ask', 'research'] as const) {
      expect(COMMAND_TASK_PROFILES[command].promptAddendum).not.toMatch(/browser_fill_form/i);
      expect(COMMAND_TASK_PROFILES[command].promptAddendum).not.toMatch(/disabled: true/i);
    }
  });

  it('tells the model how to read a fill result instead of guessing at it', () => {
    // The motivating run inferred, wrongly, that a fill had failed because the
    // committed value was not the text it typed. Every clause here removes one
    // such inference.
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;
    expect(task).toMatch(/requested/);
    expect(task).toMatch(/committed/);
    expect(task).toMatch(/resolution/);
    expect(task).toMatch(/differs from what you sent is normal/i);
    expect(task).toMatch(/never re-fill a field to force your original wording/i);
    // The three verdict kinds, and the distinction that makes the prohibition
    // correct: a skipped rung was never run, so "do not repeat it" is wrong for
    // it and right for the other two.
    expect(task).toMatch(/"succeeded" and "failed" name steps the tool already performed/i);
    expect(task).toMatch(/never repeat one of those/i);
    expect(task).toMatch(/a "skipped" entry names a step the tool did NOT take/i);
    expect(task).toMatch(/"unmet"/);
    expect(task).toMatch(/information, not a prohibition/i);
    // The offered re-issue instruction is unchanged, verbatim.
    expect(task).toMatch(/re-issue the same call with one of those strings exactly as written/i);
    expect(task).toMatch(/observed/);
  });

  it('explains the three batch sets and that a partial success is progress', () => {
    // The batch no longer stops at the first failure, so the model has to be
    // able to read a result that is neither a clean success nor a clean
    // failure — and above all must not re-send the fields that worked.
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;

    expect(task).toMatch(/"applied"/);
    expect(task).toMatch(/"failed"/);
    expect(task).toMatch(/"skipped"/);
    expect(task).toMatch(/progress, not a retry trigger/i);
    expect(task).toMatch(/re-sending them undoes work/i);
    expect(task).toMatch(/blocked_by/);
    expect(task).toMatch(/resolve that field first/i);
    expect(task).toMatch(/"covers"/);
    expect(task).toMatch(/named in another entry's "covers" is already accounted for/i);
    expect(task).toMatch(/do not re-send it as if it were missing/i);
    expect(task).toMatch(/covering entry fails, resolve all of its fields together/i);
  });

  it('explains an editee as a landed value rather than an empty field', () => {
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;

    expect(task).toMatch(/"editee"/);
    expect(task).toMatch(/the value did land there/i);
    expect(task).toMatch(/is not a failure and is not something to fix/i);
  });

  it('keeps every rule the disclosure contract established', () => {
    // Wave 1 adds to this guidance; it replaces none of it.
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;

    expect(task).toMatch(/a single browser_fill_form listing every field/i);
    expect(task).toMatch(/Set a date range in one call/i);
    expect(task).toMatch(/check-in\/check-out picker commits the pair as a unit/i);
    expect(task).toMatch(/switched_to_new_tab/);
    expect(task).toMatch(/popup_intercepted/);
    expect(task).toMatch(/never to operate a field widget by hand/i);
    expect(task).toMatch(
      /never submitting|do not use this tool to submit|submit a completed form/i,
    );
  });

  it('tells the model to operate no widget by hand', () => {
    // The motivating run gave up on the tools and drove a calendar with eleven
    // clicks. Nothing in the guidance may invite that, and the engine now opens
    // such a picker itself.
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;

    expect(task).not.toMatch(/click (?:the )?day cells/i);
    expect(task).not.toMatch(/open the (?:picker|calendar|dropdown) yourself/i);
    expect(task).toMatch(/browser_click only to/i);
  });

  it('drops the guidance the results now carry themselves', () => {
    const task = COMMAND_TASK_PROFILES.do.promptAddendum;
    // Superseded by the `attempted` field, which names what was actually tried.
    expect(task).not.toMatch(/recovery was already tried/i);
    expect(task).not.toMatch(/repeating the identical call/i);
  });

  it('names no website anywhere in the agent-facing guidance', () => {
    // The standing rule: automation works from structural signals, never from
    // knowledge of a particular site, and the guidance must not smuggle one in.
    const sites =
      /expedia|kayak|priceline|orbitz|skyscanner|booking[.]com|trip[.]com|google flights/i;
    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      expect(profile.promptAddendum).not.toMatch(sites);
    }
    for (const tool of yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do)) {
      expect(tool.description).not.toMatch(sites);
    }
  });

  it('names the disclosure fields in the tool descriptions the model reads', () => {
    const byName = new Map(
      yantraToolCatalog(buildServices(), COMMAND_TASK_PROFILES.do).map((tool) => [
        tool.name,
        tool.description,
      ]),
    );
    expect(byName.get('browser_fill_element')).toMatch(/resolution/);
    expect(byName.get('browser_fill_element')).toMatch(/attempted/);
    expect(byName.get('browser_fill_element')).toMatch(/offered/);
    expect(byName.get('browser_fill_element')).toMatch(/editee/);
    expect(byName.get('browser_fill_form')).toMatch(/resolution/);
    expect(byName.get('browser_fill_form')).toMatch(/skipped/);
    expect(byName.get('browser_click')).toMatch(/resolved_by/);
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
