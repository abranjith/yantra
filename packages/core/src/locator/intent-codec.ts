import type { JsonLocatorIntent, JsonRegex, LocatorIntent } from './types.js';

/** Converts a RegExp to its JSON-safe representation. */
function encodeRegex(re: RegExp): JsonRegex {
  return { __isRegExp: true, pattern: re.source, flags: re.flags };
}

/** Converts a JsonRegex back to a RegExp. */
function decodeRegex(jr: JsonRegex): RegExp {
  return new RegExp(jr.pattern, jr.flags);
}

function isJsonRegex(v: unknown): v is JsonRegex {
  return (
    typeof v === 'object' && v !== null && '__isRegExp' in v && (v as JsonRegex).__isRegExp === true
  );
}

/**
 * Encodes a LocatorIntent (which may contain RegExp instances) into a
 * JSON-safe JsonLocatorIntent for transmission via Runtime.evaluate.
 *
 * @example
 * encodeIntent({ kind: 'role', role: 'button', name: /sign in/i })
 * // → { kind: 'role', role: 'button', name: { __isRegExp: true, pattern: 'sign in', flags: 'i' } }
 */
export function encodeIntent(intent: LocatorIntent): JsonLocatorIntent {
  switch (intent.kind) {
    case 'role': {
      const name = intent.name instanceof RegExp ? encodeRegex(intent.name) : intent.name;
      return {
        kind: 'role',
        role: intent.role,
        ...(name !== undefined ? { name } : {}),
        ...(intent.exact !== undefined ? { exact: intent.exact } : {}),
      };
    }
    case 'testid':
      return {
        kind: 'testid',
        value: intent.value,
        ...(intent.attribute !== undefined ? { attribute: intent.attribute } : {}),
      };
    case 'label': {
      const text = intent.text instanceof RegExp ? encodeRegex(intent.text) : intent.text;
      return {
        kind: 'label',
        text,
        ...(intent.exact !== undefined ? { exact: intent.exact } : {}),
      };
    }
    case 'placeholder': {
      const text = intent.text instanceof RegExp ? encodeRegex(intent.text) : intent.text;
      return {
        kind: 'placeholder',
        text,
        ...(intent.exact !== undefined ? { exact: intent.exact } : {}),
      };
    }
    case 'text': {
      const text = intent.text instanceof RegExp ? encodeRegex(intent.text) : intent.text;
      return {
        kind: 'text',
        text,
        ...(intent.exact !== undefined ? { exact: intent.exact } : {}),
        ...(intent.normalize !== undefined ? { normalize: intent.normalize } : {}),
      };
    }
    case 'css':
      return { kind: 'css', selector: intent.selector };
    case 'xpath':
      return { kind: 'xpath', expression: intent.expression };
    case 'relative': {
      return {
        kind: 'relative',
        anchor: encodeIntent(intent.anchor),
        relation: intent.relation,
        ...(intent.targetRole !== undefined ? { targetRole: intent.targetRole } : {}),
      };
    }
  }
}

/**
 * Decodes a JsonLocatorIntent back to a LocatorIntent, restoring RegExp instances.
 *
 * @example
 * decodeIntent({ kind: 'role', role: 'button', name: { __isRegExp: true, pattern: 'sign in', flags: 'i' } })
 * // → { kind: 'role', role: 'button', name: /sign in/i }
 */
export function decodeIntent(encoded: JsonLocatorIntent): LocatorIntent {
  switch (encoded.kind) {
    case 'role': {
      const name = isJsonRegex(encoded.name) ? decodeRegex(encoded.name) : encoded.name;
      return {
        kind: 'role',
        role: encoded.role,
        ...(name !== undefined ? { name } : {}),
        ...(encoded.exact !== undefined ? { exact: encoded.exact } : {}),
      };
    }
    case 'testid':
      return {
        kind: 'testid',
        value: encoded.value,
        ...(encoded.attribute !== undefined ? { attribute: encoded.attribute } : {}),
      };
    case 'label': {
      const text = isJsonRegex(encoded.text) ? decodeRegex(encoded.text) : encoded.text;
      return {
        kind: 'label',
        text,
        ...(encoded.exact !== undefined ? { exact: encoded.exact } : {}),
      };
    }
    case 'placeholder': {
      const text = isJsonRegex(encoded.text) ? decodeRegex(encoded.text) : encoded.text;
      return {
        kind: 'placeholder',
        text,
        ...(encoded.exact !== undefined ? { exact: encoded.exact } : {}),
      };
    }
    case 'text': {
      const text = isJsonRegex(encoded.text) ? decodeRegex(encoded.text) : encoded.text;
      return {
        kind: 'text',
        text,
        ...(encoded.exact !== undefined ? { exact: encoded.exact } : {}),
        ...(encoded.normalize !== undefined ? { normalize: encoded.normalize } : {}),
      };
    }
    case 'css':
      return { kind: 'css', selector: encoded.selector };
    case 'xpath':
      return { kind: 'xpath', expression: encoded.expression };
    case 'relative': {
      return {
        kind: 'relative',
        anchor: decodeIntent(encoded.anchor),
        relation: encoded.relation,
        ...(encoded.targetRole !== undefined ? { targetRole: encoded.targetRole } : {}),
      };
    }
  }
}
