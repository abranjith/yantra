import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LocatorChain, SecretRef, ValueRef } from '../src/index.js';

describe('@no-llm refs schemas', () => {
  it('parses each ValueRef variant', () => {
    expect(ValueRef.parse({ kind: 'literal', value: 'ok' }).kind).toBe('literal');
    expect(ValueRef.parse({ kind: 'param', key: 'month' }).kind).toBe('param');
    expect(ValueRef.parse({ kind: 'secret', key: 'bank.password' }).kind).toBe('secret');
    expect(ValueRef.parse({ kind: 'capture', step_id: 's1', field: null }).kind).toBe('capture');
    expect(
      ValueRef.parse({
        kind: 'template',
        template: 'Hello {{x}}',
        bindings: { x: { kind: 'param', key: 'month' } },
      }).kind,
    ).toBe('template');
  });

  it('rejects malformed SecretRef key', () => {
    expect(SecretRef.safeParse({ kind: 'secret', key: 'oops' }).success).toBe(false);
  });

  it('round-trips ValueRef via JSON serialization', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({
            kind: fc.constant('literal'),
            value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          }),
          fc.record({ kind: fc.constant('param'), key: fc.stringMatching(/^[a-z][a-z0-9_]*$/) }),
          fc.record({
            kind: fc.constant('secret'),
            key: fc.constantFrom('bank.password', 'foo.bar'),
          }),
          fc.record({
            kind: fc.constant('capture'),
            step_id: fc.constantFrom('s1', 's2'),
            field: fc.option(fc.string(), { nil: null }),
          }),
          fc.record({
            kind: fc.constant('template'),
            template: fc.constant('x={{v}}'),
            bindings: fc.constant({ v: { kind: 'param', key: 'month' } }),
          }),
        ),
        (candidate) => {
          const parsed = ValueRef.parse(candidate);
          const reparsed = ValueRef.parse(JSON.parse(JSON.stringify(parsed)));
          expect(reparsed).toEqual(parsed);
        },
      ),
      { numRuns: 250 },
    );
  });

  it('validates nested LocatorChain intent.near structures', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 16 }), (depth) => {
        let locator: unknown = { kind: 'workflow', name: 'Target' };
        for (let index = 0; index < depth; index += 1) {
          locator = {
            kind: 'intent',
            role: 'button',
            name_match: null,
            near: locator,
          };
        }

        expect(LocatorChain.safeParse(locator).success).toBe(true);
      }),
      { numRuns: 120 },
    );
  });
});
