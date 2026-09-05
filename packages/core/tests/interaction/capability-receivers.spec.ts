import { describe, expect, it } from 'vitest';

import * as core from '../../src/index.js';
import {
  CAPABILITY_RECEIVERS,
  INTERACTION_MESSAGES,
  UnreceivableAdviceError,
  assertReceivable,
  receiverFor,
} from '../../src/index.js';

function resolvePublicReceiver(receiver: string): unknown {
  const exported = core as unknown as Record<string, unknown>;
  const [owner, member] = receiver.split('.');
  if (member === undefined) return exported[owner!];
  const constructor = exported[owner!] as { readonly prototype?: Record<string, unknown> };
  return constructor?.prototype?.[member];
}

describe('@no-llm per-family interaction capability receivers', () => {
  it('resolves every declared emitter to a public function', () => {
    for (const template of INTERACTION_MESSAGES) {
      if (template.capabilityKind !== 'engine' || template.capability === null) continue;
      expect(template.emittedBy?.length).toBeGreaterThan(0);
      for (const family of template.emittedBy ?? []) {
        const receiver = receiverFor(template.surface, family, template.capability);
        expect(typeof resolvePublicReceiver(receiver ?? '')).toBe('function');
      }
    }
  });

  it('keeps receiver triples unique', () => {
    const triples = CAPABILITY_RECEIVERS.map(
      ({ surface, family, capability }) => `${surface}\u0000${family}\u0000${capability}`,
    );
    expect(new Set(triples).size).toBe(triples.length);
  });

  it('fails the gate when the date receiver row is deleted', () => {
    const withoutDate = CAPABILITY_RECEIVERS.filter(
      (row) =>
        !(
          row.surface === 'fill' &&
          row.family === 'date' &&
          row.capability === 'selectByOfferedLabel'
        ),
    );

    expect(() =>
      assertReceivable(
        'fill',
        'WIDGET_AMBIGUOUS_CHOICE',
        'several-matched-equally',
        'date',
        withoutDate,
      ),
    ).toThrow(UnreceivableAdviceError);
  });

  it('rejects undeclared emitters and accepts declared ones', () => {
    expect(() =>
      assertReceivable('fill', 'WIDGET_TARGET_UNREACHABLE', 'value-not-offered', 'date'),
    ).toThrow(UnreceivableAdviceError);
    expect(() =>
      assertReceivable('fill', 'WIDGET_TARGET_UNREACHABLE', 'value-not-offered', 'option'),
    ).not.toThrow();
  });

  it('accepts capability-free templates without emitter metadata', () => {
    const template = INTERACTION_MESSAGES.find(
      (entry) => entry.surface === 'fill' && entry.cause === 'date-not-reachable',
    )!;
    expect(template.capability).toBeNull();
    expect(template.emittedBy).toBeUndefined();
    expect(() =>
      assertReceivable('fill', 'WIDGET_TARGET_UNREACHABLE', 'date-not-reachable', 'date'),
    ).not.toThrow();
  });

  it('leaves tool capabilities outside the engine receiver table', () => {
    const tools = INTERACTION_MESSAGES.filter((template) => template.capabilityKind === 'tool');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((template) => template.capability === 'browser_click')).toBe(true);
    expect(tools.every((template) => template.emittedBy === undefined)).toBe(true);
  });
});
