import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { decodeIntent, encodeIntent } from '../../src/locator/intent-codec.js';
import type { LocatorIntent } from '../../src/locator/types.js';

describe('@no-llm encodeIntent / decodeIntent', () => {
  it('round-trips role intent with string name', () => {
    const intent: LocatorIntent = { kind: 'role', role: 'button', name: 'Sign in', exact: true };
    const encoded = encodeIntent(intent);
    const decoded = decodeIntent(encoded);
    expect(decoded).toEqual(intent);
  });

  it('round-trips role intent with RegExp name', () => {
    const intent: LocatorIntent = { kind: 'role', role: 'textbox', name: /username/i };
    const encoded = encodeIntent(intent);
    expect(encoded.kind).toBe('role');
    const decoded = decodeIntent(encoded);
    expect(decoded.kind).toBe('role');
    if (decoded.kind === 'role') {
      expect(decoded.name).toBeInstanceOf(RegExp);
      expect((decoded.name as RegExp).source).toBe('username');
      expect((decoded.name as RegExp).flags).toBe('i');
    }
  });

  it('round-trips testid intent', () => {
    const intent: LocatorIntent = { kind: 'testid', value: 'login-btn', attribute: 'data-qa' };
    expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
  });

  it('round-trips label intent with regex', () => {
    const intent: LocatorIntent = { kind: 'label', text: /email/i };
    const decoded = decodeIntent(encodeIntent(intent));
    expect(decoded.kind).toBe('label');
    if (decoded.kind === 'label') {
      expect(decoded.text).toBeInstanceOf(RegExp);
    }
  });

  it('round-trips placeholder intent', () => {
    const intent: LocatorIntent = { kind: 'placeholder', text: 'Enter email', exact: false };
    expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
  });

  it('round-trips text intent', () => {
    const intent: LocatorIntent = { kind: 'text', text: 'Hello world', normalize: true };
    expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
  });

  it('round-trips css intent', () => {
    const intent: LocatorIntent = { kind: 'css', selector: 'button.submit' };
    expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
  });

  it('round-trips xpath intent', () => {
    const intent: LocatorIntent = { kind: 'xpath', expression: '/html/body/button[1]' };
    expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
  });

  it('round-trips relative intent with nested role anchor', () => {
    const intent: LocatorIntent = {
      kind: 'relative',
      anchor: { kind: 'role', role: 'heading', name: 'Username' },
      relation: 'next-sibling',
      targetRole: 'textbox',
    };
    const decoded = decodeIntent(encodeIntent(intent));
    expect(decoded.kind).toBe('relative');
    if (decoded.kind === 'relative') {
      expect(decoded.anchor.kind).toBe('role');
      expect(decoded.relation).toBe('next-sibling');
      expect(decoded.targetRole).toBe('textbox');
    }
  });

  it('encodeIntent produces JSON-serializable output (no RegExp instances)', () => {
    const intent: LocatorIntent = { kind: 'role', role: 'button', name: /sign in/i };
    const encoded = encodeIntent(intent);
    // Should not throw
    const json = JSON.stringify(encoded);
    const parsed = JSON.parse(json) as unknown;
    // Re-decode from JSON
    const reDecode = decodeIntent(parsed as Parameters<typeof decodeIntent>[0]);
    expect(reDecode.kind).toBe('role');
    if (reDecode.kind === 'role') {
      expect(reDecode.name).toBeInstanceOf(RegExp);
    }
  });

  it('property: round-trip preserves semantics for all string-based intents', () => {
    const stringIntents: LocatorIntent[] = [
      { kind: 'css', selector: 'button' },
      { kind: 'xpath', expression: '//button' },
      { kind: 'testid', value: 'btn' },
      { kind: 'label', text: 'Email', exact: true },
      { kind: 'placeholder', text: 'Enter name', exact: false },
      { kind: 'text', text: 'Submit' },
    ];

    for (const intent of stringIntents) {
      expect(decodeIntent(encodeIntent(intent))).toEqual(intent);
    }
  });

  it('property: encodeIntent + JSON.stringify + JSON.parse + decodeIntent round-trips regex', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.constantFrom('i', 'g', 'gi', ''),
        (pattern, flags) => {
          try {
            new RegExp(pattern, flags);
          } catch {
            return true; // skip invalid regex
          }
          const intent: LocatorIntent = { kind: 'text', text: new RegExp(pattern, flags) };
          const encoded = encodeIntent(intent);
          const json = JSON.stringify(encoded);
          const parsed = JSON.parse(json) as Parameters<typeof decodeIntent>[0];
          const decoded = decodeIntent(parsed);
          if (decoded.kind === 'text') {
            // Compare against new RegExp(pattern, flags).source, not the raw pattern:
            // V8 may escape chars like a leading "/" in .source even if the pattern string
            // itself is unescaped (e.g. "/ " → "\/ "). The round-trip preserves .source,
            // not the original pattern literal.
            const canonical = new RegExp(pattern, flags);
            return (
              decoded.text instanceof RegExp &&
              (decoded.text as RegExp).source === canonical.source &&
              (decoded.text as RegExp).flags === canonical.flags
            );
          }
          return false;
        },
      ),
    );
  });
});
