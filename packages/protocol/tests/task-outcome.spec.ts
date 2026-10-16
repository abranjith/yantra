import { describe, expect, it } from 'vitest';

import {
  AgentManifestSection,
  BRIEF_MAX_EXEMPTIONS,
  BRIEF_MAX_REQUIREMENTS,
  Brief,
  BriefRequirement,
  FailureClass,
  TaskEvent,
  TaskOutcome,
  TerminationReason,
} from '../src/index.js';

import { makeBrief } from './brief-factories.js';

const ESC = String.fromCharCode(0x1b);

const requirement = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'artifact:screenshot:viewport',
  label: 'viewport screenshot',
  status: 'unmet',
  reason: 'not captured',
  declared_in: 1,
  ...overrides,
});

const manifest = () => ({
  adapter: 'pi-coding-agent' as const,
  sdk_version: '0.80.6',
  provider: 'anthropic',
  model: 'claude-sonnet',
  thinking: 'medium',
  auth_source: 'managed' as const,
  session_id: 'session-1',
  session_file: 'agent/session-1.jsonl',
  prompt_version: 'agent-v10' as const,
  prompt_hash: 'a'.repeat(64),
  tool_catalog_hash: 'a'.repeat(64),
});

describe('@no-llm task outcome vocabulary (FEAT-054)', () => {
  it('names exactly the five outcomes', () => {
    expect(TaskOutcome.options).toEqual(['fulfilled', 'partial', 'handoff', 'failed', 'aborted']);
    expect(TaskOutcome.safeParse('published').success).toBe(false);
    expect(TaskOutcome.safeParse('completed').success).toBe(false);
  });

  it('gives every termination reason a non-empty kebab- or snake-case token', () => {
    expect(TerminationReason.options.length).toBeGreaterThan(0);
    for (const reason of TerminationReason.options) {
      expect(reason).toMatch(/^[a-z]+(?:[-_][a-z]+)*$/);
    }
    expect(TerminationReason.options).toEqual(
      expect.arrayContaining(['model_finished', 'wall-clock-soft', 'wall-clock-hard', 'handoff']),
    );
  });

  it('adds requirements_unmet to the failure classes', () => {
    expect(FailureClass.parse('requirements_unmet')).toBe('requirements_unmet');
    expect(FailureClass.parse('budget_exhausted')).toBe('budget_exhausted');
  });
});

describe('@no-llm task_failed events carry an optional task outcome', () => {
  const base = {
    task_id: 'task-1',
    at: '2026-10-15T12:00:00.000Z',
    kind: 'task_failed' as const,
    failure_class: 'budget_exhausted' as const,
    report_path: 'report.md',
  };

  it('parses an older task_failed line without task_outcome unchanged', () => {
    expect(TaskEvent.parse(base)).toEqual(base);
  });

  it('parses a task_failed line with a task outcome and rejects an unknown one', () => {
    expect(TaskEvent.parse({ ...base, task_outcome: 'partial' })).toEqual({
      ...base,
      task_outcome: 'partial',
    });
    expect(TaskEvent.safeParse({ ...base, task_outcome: 'published' }).success).toBe(false);
  });
});

describe('@no-llm Brief requirements (FEAT-054)', () => {
  it('parses a Brief without requirements unchanged', () => {
    const brief = makeBrief();
    const parsed = Brief.parse(JSON.parse(JSON.stringify(brief)));
    expect(parsed.requirements).toBeUndefined();
    expect('requirements' in parsed).toBe(false);
  });

  it('round-trips a Brief with requirements and fill exemptions', () => {
    const brief = makeBrief({
      requirements: [
        requirement(),
        requirement({
          id: 'fill',
          label: 'fill all eligible fields',
          status: 'met',
          reason: 'fields 48 of 48 filled',
          exemptions: [
            { label: 'Upload resume', reason: 'file_input' },
            { label: 'Account id', reason: 'read_only' },
          ],
          exempt_overflow: 3,
        }),
        requirement({
          id: 'effects.submit',
          label: 'do not submit',
          status: 'met',
          reason: null,
          declared_in: null,
        }),
        requirement({ id: 'deliverable', label: 'actions', status: 'not_applicable' }),
      ],
    } as Parameters<typeof makeBrief>[0]);
    expect(Brief.parse(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
  });

  it('rejects duplicate requirement ids within a Brief', () => {
    const result = Brief.safeParse(
      makeBrief({ requirements: [requirement(), requirement()] } as Parameters<
        typeof makeBrief
      >[0]),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['requirements', 1, 'id']);
  });

  it('bounds the requirement list, its text, and its exemptions', () => {
    const many = Array.from({ length: BRIEF_MAX_REQUIREMENTS + 1 }, (_, index) =>
      requirement({ id: `filter:f${index}` }),
    );
    expect(
      Brief.safeParse(makeBrief({ requirements: many } as Parameters<typeof makeBrief>[0])).success,
    ).toBe(false);
    expect(BriefRequirement.safeParse(requirement({ label: 'x'.repeat(121) })).success).toBe(false);
    expect(BriefRequirement.safeParse(requirement({ reason: 'x'.repeat(201) })).success).toBe(
      false,
    );
    const exemptions = Array.from({ length: BRIEF_MAX_EXEMPTIONS + 1 }, () => ({
      label: 'Field',
      reason: 'hidden',
    }));
    expect(BriefRequirement.safeParse(requirement({ exemptions })).success).toBe(false);
    expect(BriefRequirement.safeParse(requirement({ exempt_overflow: 0 })).success).toBe(false);
  });

  it('rejects ANSI escapes, unknown statuses, ids, and exemption reasons', () => {
    for (const bad of [
      { label: `bad ${ESC}[31m label` },
      { reason: `bad ${ESC}[31m reason` },
      { status: 'partially_met' },
      { id: 'artifact:video:viewport' },
      { exemptions: [{ label: 'Password', reason: 'password' }] },
      { declared_in: 0 },
    ]) {
      expect(BriefRequirement.safeParse(requirement(bad)).success).toBe(false);
    }
  });
});

describe('@no-llm agent manifest provenance additions (FEAT-054)', () => {
  it('parses a manifest agent section without the new fields unchanged', () => {
    expect(AgentManifestSection.parse(manifest())).toEqual(manifest());
  });

  it('accepts the yantra version and effective budgets, with null for unbounded axes', () => {
    const value = {
      ...manifest(),
      prompt_version: 'agent-v11' as const,
      yantra_version: '0.0.0',
      budgets: {
        wall_clock_ms: null,
        soft_wall_clock_fraction: 0.8,
        max_provider_tokens: 400000,
        max_navigations: 30,
        max_hosts: 20,
        tool_retries: 3,
      },
    };
    expect(AgentManifestSection.parse(value)).toEqual(value);
  });

  it('rejects unknown budget keys and out-of-range values', () => {
    const budgets = {
      wall_clock_ms: 900000,
      soft_wall_clock_fraction: 0.8,
      max_provider_tokens: null,
      max_navigations: 30,
      max_hosts: 20,
      tool_retries: 3,
    };
    expect(
      AgentManifestSection.safeParse({ ...manifest(), budgets: { ...budgets, extra: 1 } }).success,
    ).toBe(false);
    expect(
      AgentManifestSection.safeParse({
        ...manifest(),
        budgets: { ...budgets, soft_wall_clock_fraction: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      AgentManifestSection.safeParse({ ...manifest(), budgets: { ...budgets, max_hosts: -1 } })
        .success,
    ).toBe(false);
    expect(AgentManifestSection.safeParse({ ...manifest(), yantra_version: '' }).success).toBe(
      false,
    );
  });
});
