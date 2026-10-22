import { DefaultSanitizer, type FillCensus, type AgentBrowserController } from '@yantra/core';
import { RunHealth } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ActionLedger } from '../../src/runtime/action-ledger.js';
import {
  ProgressLedger,
  renderProgressLine,
  type ProgressSources,
} from '../../src/runtime/progress-ledger.js';
import { STALL_POLICY, isStalled } from '../../src/runtime/recovery.js';
import { withRunProgress } from '../../src/runtime/run-services.js';
import { NO_ACTION_TERMS, type EffectiveActionTerms } from '../../src/runtime/task-contract.js';
import { buildServices } from '../adapters/pi/tools/test-support.js';

function fixture() {
  let time = 0;
  let documents = 0;
  let page: ReturnType<ProgressSources['page']> = null;
  let census: FillCensus | null = null;
  let terms: EffectiveActionTerms = NO_ACTION_TERMS;
  const ledger = new ActionLedger({
    nowIso: () => new Date(time).toISOString(),
    locate: () => ({ epoch: 1, host: 'fixture.example' }),
    sanitizer: new DefaultSanitizer(),
  });
  const sources: ProgressSources = {
    documentCount: () => documents,
    page: () => page,
    ledger,
    census: () => census,
    terms: () => terms,
    contract: () => null,
  };
  const progress = new ProgressLedger(sources, () => time, 'enforce');
  const checkpoint = (role: 'counted' | 'bookkeeping' = 'counted') =>
    progress.checkpoint({ tool: 'synthetic', role });
  return {
    progress,
    ledger,
    checkpoint,
    sources,
    setTime: (value: number) => {
      time = value;
    },
    setDocuments: (value: number) => {
      documents = value;
    },
    setPage: (url: string, epoch = 1) => {
      page = { url, epoch };
    },
    setCensus: (value: FillCensus) => {
      census = value;
    },
    setTerms: (value: EffectiveActionTerms) => {
      terms = value;
    },
  };
}

describe('@no-llm FEAT-059 semantic progress', () => {
  it('counts unchanged successes, empty catalogs and refused explorations identically', () => {
    const f = fixture();
    f.setPage('https://fixture.example/form#first');
    expect(f.checkpoint().signals).toContain('new_page');
    f.setPage('https://fixture.example/form#second', 2);
    expect(f.checkpoint().noProgressCalls).toBe(1);
    expect(f.checkpoint().noProgressCalls).toBe(2);
    f.setTime(130000);
    expect(f.checkpoint()).toMatchObject({
      advanced: false,
      noProgressCalls: 3,
      msSinceProgress: 130000,
    });
    f.setDocuments(1);
    expect(f.checkpoint().signals).toEqual(['new_document']);
  });
  it('counts nine verified fills in a partially failed batch and reuses the cached census', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
    });
    f.setCensus({
      epoch: 1,
      host: 'fixture.example',
      complete: true,
      controls: Array.from({ length: 10 }, (_, i) => ({
        ref: `e${i + 1}`,
        label: `Private label ${i}`,
        groupKey: null,
        exemption: null,
      })),
    });
    f.checkpoint();
    for (let i = 1; i <= 9; i++)
      f.ledger.record({
        kind: 'fill_committed',
        tool: 'browser_fill_form',
        ref: `e${i}`,
        field: 'Private label',
        groupKey: null,
        covers: 1,
      });
    expect(f.checkpoint().signals).toEqual(['action_verified', 'item_advanced']);
    expect(f.progress.summary().fill).toEqual({ done: 9, total: 10 });
    expect(JSON.stringify(f.progress.summary())).not.toContain('Private label');
  });
  it('counts listed names without a census, ignoring duplicate and unrelated commits', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      fill: { coverage: 'listed', fields: ['Answer 1', 'Answer 2'], declaredIn: 1 },
    });
    f.checkpoint('bookkeeping');
    expect(f.progress.summary().fill).toEqual({ done: 0, total: 2 });
    const record = (field: string) =>
      f.ledger.record({
        kind: 'fill_committed',
        tool: 'browser_fill_form',
        ref: 'e1',
        field,
        groupKey: null,
        covers: 1,
      });
    record('Answer 1');
    record('answer 1');
    record('Unrequested');
    expect(f.checkpoint().signals).toContain('item_advanced');
    expect(f.progress.summary().fill).toEqual({ done: 1, total: 2 });
    expect(f.progress.liveItems()[0]?.state).toBe('advancing');
    f.setCensus({ epoch: 1, host: 'fixture.example', complete: true, controls: [] });
    record('Answer 2');
    f.checkpoint();
    expect(f.progress.summary().fill).toEqual({ done: 2, total: 2 });
    expect(f.progress.liveItems()[0]?.state).toBe('met');
  });
  it('ignores a refused submit but counts saved captures and shared artifact fulfillment', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      submit: { value: 'forbidden', declaredIn: 1 },
      artifacts: [{ kind: 'screenshot', scope: 'viewport', declaredIn: 1 }],
    });
    f.ledger.record({
      kind: 'submit_refused',
      ref: 'e1',
      name: 'submit',
      signal: 'name',
    });
    expect(f.checkpoint().signals).toEqual([]);
    f.ledger.record({
      kind: 'capture',
      scope: 'viewport',
      path: 'capture.png',
      sha256: 'a'.repeat(64),
      bytes: 10,
      producer: 'browser_capture',
    });
    expect(f.checkpoint().signals).toEqual(['action_verified', 'artifact_saved', 'item_advanced']);
    expect(f.progress.liveItems().find((i) => i.kind === 'artifact')?.state).toBe('met');
  });
  it('bookkeeping changes no counters; no-census fills stay pending and verified actions still count', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
    });
    const baseline = f.checkpoint('bookkeeping');
    expect(baseline.changedItems).toHaveLength(1);
    expect(baseline.signals).toEqual([]);
    const before = f.progress.summary();
    expect(before.counted_calls).toBe(0);
    f.setDocuments(1);
    f.checkpoint('bookkeeping');
    expect(f.progress.summary()).toEqual(before);
    expect(f.progress.liveItems()[0]).toMatchObject({ state: 'pending', done: null, total: null });
    f.ledger.record({
      kind: 'fill_committed',
      tool: 'browser_fill_form',
      ref: 'e1',
      field: 'name',
      groupKey: null,
      covers: 1,
    });
    expect(f.checkpoint().signals).toContain('action_verified');
  });
  it('does not advance an artifact item for an unrelated capture scope', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      artifacts: [{ kind: 'screenshot', scope: 'full_page', declaredIn: 1 }],
    });
    f.checkpoint('bookkeeping');
    f.ledger.record({
      kind: 'capture',
      scope: 'element',
      path: 'capture.png',
      sha256: 'a'.repeat(64),
      bytes: 10,
      producer: 'browser_capture',
    });
    expect(f.checkpoint().signals).toEqual(['action_verified', 'artifact_saved']);
    expect(f.progress.liveItems()[0]?.state).toBe('pending');
  });
  it('never calls an active browser reader, including over fifty checkpoints', () => {
    const controller = {
      observe: vi.fn(),
      evaluate: vi.fn(),
      fillCensus: vi.fn(),
      launched: true,
      url: () => 'https://fixture.example/form',
      topLevelDocumentEpoch: () => 1,
      latestFillCensus: () => null,
    };
    const spies = [
      vi.spyOn(controller, 'observe'),
      vi.spyOn(controller, 'evaluate'),
      vi.spyOn(controller, 'fillCensus'),
    ];
    const base = buildServices();
    const services = withRunProgress(
      {
        ...base,
        domain: {
          ...base.domain,
          browser: { controller: controller as unknown as AgentBrowserController } as NonNullable<
            typeof base.domain.browser
          >,
        },
      },
      'enforce',
    );
    for (let i = 0; i < 50; i++)
      services.progress.checkpoint({ tool: 'browser_extract', role: 'counted' });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(services.progress.summary().counted_calls).toBe(50);
    // The actual schema remains the artifact authority.
    const schema = RunHealth.innerType().shape.progress;
    expect(schema.safeParse(services.progress.summary()).success).toBe(true);
  });
  it('renders bounded progress with counts, pending inventory and overflow', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      fill: { coverage: 'all_eligible', fields: [], declaredIn: 1 },
    });
    const item = f.progress.liveItems()[0]!;
    expect(renderProgressLine([item])).toBe('fields pending');
    expect(renderProgressLine([{ ...item, done: 9, total: 48 }])).toBe('fields 9/48');
    expect(renderProgressLine([item, item, item, item, item])).toContain('+2 more');
  });
  it('reserves one late attempt per unmet scope, including when another capture succeeds', () => {
    const f = fixture();
    f.setTerms({
      ...NO_ACTION_TERMS,
      artifacts: [
        { kind: 'screenshot', scope: 'viewport', declaredIn: 1 },
        { kind: 'screenshot', scope: 'element', declaredIn: 1 },
      ],
    });
    expect(f.progress.captureExemptionAvailable('viewport')).toBe(true);
    expect(f.progress.captureExemptionAvailable('full_page')).toBe(true);
    f.progress.reserveExemptCapture('viewport');
    expect(f.progress.captureExemptionAvailable('viewport')).toBe(false);
    f.ledger.record({
      kind: 'capture',
      scope: 'viewport',
      path: 'capture.png',
      sha256: 'a'.repeat(64),
      bytes: 10,
      producer: 'browser_capture',
    });
    expect(f.progress.captureExemptionAvailable('element')).toBe(true);
    f.progress.reserveExemptCapture('element');
    expect(f.progress.captureExemptionAvailable('element')).toBe(false);
    expect(f.progress.exemptCapturesUsed()).toBe(2);
  });
});

describe('@no-llm REV-004 repeated actions do not reset the stall window', () => {
  const fill = (ref: string, extra: { groupKey?: string; coveredRefs?: string[] } = {}) => ({
    kind: 'fill_committed' as const,
    tool: 'browser_fill_form' as const,
    ref,
    field: `Field ${ref}`,
    groupKey: extra.groupKey ?? null,
    covers: 1,
    ...(extra.coveredRefs === undefined ? {} : { coveredRefs: extra.coveredRefs }),
  });
  const click = (ref: string) => ({
    kind: 'click_executed' as const,
    ref,
    name: `Control ${ref}`,
    submitClass: null,
  });
  const capture = (sha: string) => ({
    kind: 'capture' as const,
    scope: 'viewport' as const,
    path: `screenshots/capture-1-${sha.slice(0, 12)}.png`,
    sha256: sha,
    bytes: 10,
    producer: 'browser_capture',
  });

  it('a field re-filled again and again reaches the stall threshold', () => {
    const f = fixture();
    f.ledger.record(fill('e1'));
    expect(f.checkpoint().signals).toEqual(['action_verified']);

    let last = f.checkpoint();
    for (let call = 0; call < STALL_POLICY.noProgressCalls; call += 1) {
      f.ledger.record(fill('e1'));
      last = f.checkpoint();
      expect(last.signals).toEqual([]);
    }

    expect(last.noProgressCalls).toBeGreaterThanOrEqual(STALL_POLICY.noProgressCalls);
    expect(isStalled(last, false)).toBe(true);
  });

  it('a control clicked repeatedly on one document reaches the stall threshold', () => {
    const f = fixture();
    f.ledger.record(click('e4'));
    expect(f.checkpoint().signals).toEqual(['action_verified']);

    let last = f.checkpoint();
    for (let call = 0; call < STALL_POLICY.noProgressCalls; call += 1) {
      f.ledger.record(click('e4'));
      last = f.checkpoint();
    }

    expect(isStalled(last, false)).toBe(true);
  });

  it('an identical capture is not new evidence, a different one is', () => {
    const f = fixture();
    f.ledger.record(capture('a'.repeat(64)));
    expect(f.checkpoint().signals).toEqual(['action_verified', 'artifact_saved']);

    f.ledger.record(capture('a'.repeat(64)));
    expect(f.checkpoint().signals).toEqual([]);

    f.ledger.record(capture('b'.repeat(64)));
    expect(f.checkpoint().signals).toEqual(['action_verified', 'artifact_saved']);
  });

  it('a new field, a pair leg, or one new field in a batch of repeats still counts', () => {
    const f = fixture();
    f.ledger.record(fill('e1'));
    f.checkpoint();

    f.ledger.record(fill('e2'));
    expect(f.checkpoint().signals).toContain('action_verified');

    f.ledger.record(fill('e3', { coveredRefs: ['e3', 'e4'] }));
    expect(f.checkpoint().signals).toContain('action_verified');
    f.ledger.record(fill('e4'));
    expect(f.checkpoint().signals).toEqual([]);

    f.ledger.record(fill('e1'));
    f.ledger.record(fill('e2'));
    f.ledger.record(fill('e5'));
    const mixed = f.checkpoint();
    expect(mixed.signals).toContain('action_verified');
    expect(mixed.noProgressCalls).toBe(0);
  });

  it('a group counts once: another option of the same radio group is not new coverage', () => {
    const f = fixture();
    f.ledger.record(fill('e7', { groupKey: 'radio:plan' }));
    expect(f.checkpoint().signals).toContain('action_verified');

    f.ledger.record(fill('e8', { groupKey: 'radio:plan' }));
    expect(f.checkpoint().signals).toEqual([]);
  });

  it('the same ref on a new document is new coverage', () => {
    let epoch = 1;
    const ledger = new ActionLedger({
      nowIso: () => new Date(0).toISOString(),
      locate: () => ({ epoch, host: 'fixture.example' }),
      sanitizer: new DefaultSanitizer(),
    });
    const progress = new ProgressLedger(
      {
        documentCount: () => 0,
        page: () => null,
        ledger,
        census: () => null,
        terms: () => NO_ACTION_TERMS,
        contract: () => null,
      },
      () => 0,
      'enforce',
    );
    const checkpoint = () => progress.checkpoint({ tool: 'synthetic', role: 'counted' });
    ledger.record(click('e2'));
    expect(checkpoint().signals).toEqual(['action_verified']);
    ledger.record(click('e2'));
    expect(checkpoint().signals).toEqual([]);

    epoch = 2;
    ledger.record(click('e2'));

    expect(checkpoint().signals).toEqual(['action_verified']);
  });
});
