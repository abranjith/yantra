/** @no-llm Additive action evidence and referential integrity. */
import { describe, expect, it } from 'vitest';

import { ActionId, BriefAction, Brief, ToolAuditEntry } from '../src/index.js';

import { makeBrief } from './brief-factories.js';

const fill = {
  id: 'A1',
  kind: 'fill',
  label: 'Name',
  epoch: 1,
  call_id: 'call-1',
  host: 'example.test',
  label_origin: 'structural',
  confidence: 'medium',
  verification: { resolution: 'exact' },
} as const;

describe('@no-llm action protocol', () => {
  it('accepts only positive, uppercase action IDs', () => {
    for (const id of ['A1', 'A40', 'A999']) expect(ActionId.safeParse(id).success).toBe(true);
    for (const id of ['A0', 'A01', 'a3', 'A-1', 'A1x', 'A1\n'])
      expect(ActionId.safeParse(id).success).toBe(false);
  });
  it('allows kind-specific evidence only on its kind', () => {
    expect(BriefAction.safeParse(fill).success).toBe(true);
    for (const invalid of [
      { ...fill, kind: 'click' },
      { ...fill, artifacts: [] },
      { ...fill, signal: 'name' },
      { ...fill, label: String.fromCharCode(27) },
      { ...fill, label_origin: 'explicit' },
      { ...fill, label_origin: undefined },
      { ...fill, value: 'never persisted' },
    ])
      expect(BriefAction.safeParse(invalid).success).toBe(false);
    expect(
      BriefAction.safeParse({
        ...fill,
        verification: { withheld: { reason: 'password', verdict: 'exact' } },
      }).success,
    ).toBe(true);
    expect(
      BriefAction.safeParse({
        id: 'A2',
        kind: 'capture',
        label: null,
        epoch: null,
        call_id: null,
        host: null,
        artifacts: [
          {
            kind: 'screenshot',
            path: '../x.png',
            sha256: 'a'.repeat(64),
            mime_type: 'image/png',
            bytes: 2,
            sent_to_model: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('keeps old Briefs unchanged and validates all structured action references', () => {
    const old = makeBrief();
    expect(Brief.parse(old)).toEqual(old);
    const brief = {
      ...old,
      actions: [fill],
      key_findings: [
        { text: 'Filled Name [A1]', citations: [], actions: ['A1'], editorial: false },
      ],
    };
    expect(Brief.safeParse(brief).success).toBe(true);
    expect(Brief.safeParse({ ...brief, actions: [] }).success).toBe(false);
    expect(Brief.safeParse({ ...brief, actions: [fill, fill] }).success).toBe(false);
    expect(
      Brief.safeParse({
        ...brief,
        actions: Array.from({ length: 41 }, (_, index) => ({ ...fill, id: `A${index + 1}` })),
      }).success,
    ).toBe(false);
    expect(
      Brief.safeParse({
        ...brief,
        sections: [{ heading: 'Done', body_md: '', citations: [], actions: ['A9'] }],
      }).success,
    ).toBe(false);
    expect(
      Brief.safeParse({
        ...brief,
        facets: { comparison: { columns: ['Field'], rows: [['Name']], row_actions: [['A9']] } },
      }).success,
    ).toBe(false);
  });
  it('permits action IDs only on successful audit end entries', () => {
    const end = {
      ts: '2026-10-18T12:00:00.000Z',
      seq: 1,
      run_id: 'run',
      session_id: 'session',
      call_id: 'call',
      tool: 'browser_fill_form',
      phase: 'end',
      input_sanitized: null,
      output_sanitized: {},
      status: 'ok',
      duration_ms: 1,
      error_code: null,
      confirmation_id: null,
    };
    expect(ToolAuditEntry.safeParse(end).success).toBe(true);
    expect(ToolAuditEntry.safeParse({ ...end, actions: ['A1'] }).success).toBe(true);
    for (const overrides of [
      { phase: 'start' },
      { status: 'error' },
      { actions: ['A0'] },
      { actions: Array(17).fill('A1') },
    ])
      expect(ToolAuditEntry.safeParse({ ...end, actions: ['A1'], ...overrides }).success).toBe(
        false,
      );
  });
});
