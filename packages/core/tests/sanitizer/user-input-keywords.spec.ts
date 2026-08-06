import { describe, expect, it } from 'vitest';

import { detectKeywordValues, type InputSegment } from '../../src/sanitizer/index.js';

function detect(text: string): string {
  const segments = detectKeywordValues(
    [{ kind: 'literal', text }],
    (tag, value): InputSegment => ({ kind: 'value', tag, value }),
  );
  return segments
    .map((segment) =>
      segment.kind === 'literal' ? segment.text : `{{${segment.tag}:${segment.value}}}`,
    )
    .join('');
}

describe('@no-llm user-input keyword look-around', () => {
  it('detects the motivating username/password sentence without touching the host', () => {
    expect(detect('enter website xyz with username u1, password p1')).toBe(
      'enter website xyz with username {{username:u1}}, password {{password:p1}}',
    );
  });

  it.each([
    ['password: hunter2', 'password: {{password:hunter2}}'],
    ['password=hunter2', 'password={{password:hunter2}}'],
    ['password is hunter2', 'password is {{password:hunter2}}'],
    ['my password is "hunter 2"', 'my password is "{{password:hunter 2}}"'],
    ['password for my account is x', 'password for my account is {{password:x}}'],
  ])('accepts separator and connector form %s', (input, expected) => {
    expect(detect(input)).toBe(expected);
  });

  it.each([
    'search for password managers',
    'reset my password',
    'the password field',
    'how strong is password strength scoring',
  ])('does not fire for ordinary prose: %s', (input) => {
    expect(detect(input)).toBe(input);
  });

  it('classifies national identifiers and preempts later shape tags', () => {
    expect(detect('ssn 123-45-6789')).toBe('ssn {{national_id:123-45-6789}}');
  });

  it('classifies a card-shaped password as password', () => {
    expect(detect('password 4111111111111111')).toBe('password {{password:4111111111111111}}');
  });

  it('is case-insensitive and leaves the next keyword available to match', () => {
    expect(detect('USERNAME U1, PASSWORD P1')).toBe(
      'USERNAME {{username:U1}}, PASSWORD {{password:P1}}',
    );
  });
});
