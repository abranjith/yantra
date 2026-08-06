import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  UserInputMarkerError,
  parseUserInputMarkers,
  type InputSegment,
  type UserInputValueTag,
} from '../../src/sanitizer/index.js';

function values(segments: readonly InputSegment[]): readonly InputSegment[] {
  return segments.filter((segment) => segment.kind === 'value');
}

describe('@no-llm user-input marker grammar', () => {
  it('parses bare and tagged markers into protected value segments', () => {
    expect(parseUserInputMarkers('@{p1}')).toEqual([{ kind: 'value', tag: 'secret', value: 'p1' }]);
    expect(parseUserInputMarkers('@password{p1}')).toEqual([
      { kind: 'value', tag: 'password', value: 'p1' },
    ]);
  });

  it('consumes balanced braces without reparsing nested marker-looking text', () => {
    expect(parseUserInputMarkers('@{{"k":"v"}}')).toEqual([
      { kind: 'value', tag: 'secret', value: '{"k":"v"}' },
    ]);
    expect(parseUserInputMarkers('@{a{b}c}')).toEqual([
      { kind: 'value', tag: 'secret', value: 'a{b}c' },
    ]);
    expect(parseUserInputMarkers('@{a @{b} c}')).toEqual([
      { kind: 'value', tag: 'secret', value: 'a @{b} c' },
    ]);
  });

  it('handles the three escapes while retaining non-escape backslashes', () => {
    expect(parseUserInputMarkers('@{p\\}1}')).toEqual([
      { kind: 'value', tag: 'secret', value: 'p}1' },
    ]);
    expect(parseUserInputMarkers('@{a\\\\b}')).toEqual([
      { kind: 'value', tag: 'secret', value: 'a\\b' },
    ]);
    expect(parseUserInputMarkers('@{C:\\Users\\x}')).toEqual([
      { kind: 'value', tag: 'secret', value: 'C:\\Users\\x' },
    ]);
  });

  it('uses @@ as a literal opt-out and leaves ordinary email at-signs alone', () => {
    expect(parseUserInputMarkers('@@{x}')).toEqual([{ kind: 'literal', text: '@{x}' }]);
    expect(values(parseUserInputMarkers('a@b.com'))).toHaveLength(0);
    expect(parseUserInputMarkers('user@example.org')).toEqual([
      { kind: 'literal', text: 'user@example.org' },
    ]);
  });

  it.each([
    ['@{unterminated', 'unterminated', 1],
    ['before @passwrd{x}', 'unknown_tag', 8],
    ['@auth_param{x}', 'unknown_tag', 1],
    ['@{}', 'empty_value', 1],
    ['@{   }', 'empty_value', 1],
    [`@{${'x'.repeat(2049)}}`, 'value_too_long', 1],
    ['do the {{user:email:1}} thing', 'reserved_placeholder', 8],
    ['@{C:\\Users\\x\\}', 'unterminated', 1],
  ] as const)('reports %s as %s at the 1-based column', (input, reason, column) => {
    try {
      parseUserInputMarkers(input);
      throw new Error('expected parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UserInputMarkerError);
      expect(error).toMatchObject({ reason, column, offset: column - 1 });
      expect((error as Error).message).toContain(`column ${column}`);
    }
  });

  it('property: minimally escaped generated values round-trip through rendered markers', () => {
    const tags: readonly UserInputValueTag[] = [
      'secret',
      'username',
      'password',
      'pin',
      'otp',
      'national_id',
      'vin',
      'account',
      'dob',
      'address',
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tag: fc.constantFrom(...tags),
            value: fc
              .string({ minLength: 1, maxLength: 40 })
              .filter((candidate) => candidate.trim().length > 0),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (generated) => {
          const rendered = generated
            .map(({ tag, value }) => {
              const escaped = value.replace(/[\\{}]/g, (character) => `\\${character}`);
              return tag === 'secret' ? `@{${escaped}}` : `@${tag}{${escaped}}`;
            })
            .join(' / ');
          expect(values(parseUserInputMarkers(rendered))).toEqual(
            generated.map(({ tag, value }) => ({ kind: 'value', tag, value })),
          );
        },
      ),
      { numRuns: 250 },
    );
  });
});
