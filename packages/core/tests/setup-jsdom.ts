/**
 * Vitest global setup — polyfills for jsdom tests.
 *
 * jsdom exposes CSS.escape via window.CSS.escape, but does not always register it
 * as a bare global. Similarly, document.elementFromPoint exists in modern jsdom
 * but vi.spyOn requires the property to be configurable, which some jsdom versions
 * do not guarantee.
 *
 * This file runs before every test file (setupFiles in vitest.config.ts). Guards
 * ensure the polyfills only apply when the jsdom environment is active.
 */

if (typeof document !== 'undefined') {
  // CSS.escape polyfill — W3C CSSOM spec implementation
  // https://drafts.csswg.org/cssom/#serialize-an-identifier
  if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
    const cssEscapePolyfill = (value: string): string => {
      const str = String(value);
      const n = str.length;
      let result = '';

      for (let i = 0; i < n; i++) {
        const cp = str.charCodeAt(i);

        if (cp === 0x0000) {
          result += '�';
          continue;
        }
        // Control characters or DEL — use hex escape
        if ((cp >= 0x0001 && cp <= 0x001f) || cp === 0x007f) {
          result += `\\${cp.toString(16).toUpperCase()} `;
          continue;
        }
        // Leading digit
        if (i === 0 && cp >= 0x0030 && cp <= 0x0039) {
          result += `\\${cp.toString(16).toUpperCase()} `;
          continue;
        }
        // Second char digit when first char is '-'
        if (i === 1 && cp >= 0x0030 && cp <= 0x0039 && str.charCodeAt(0) === 0x002d) {
          result += `\\${cp.toString(16).toUpperCase()} `;
          continue;
        }
        // Leading lone hyphen
        if (i === 0 && n === 1 && cp === 0x002d) {
          result += `\\${str[i]}`;
          continue;
        }
        // Safe chars: high unicode, hyphen, underscore, digits, letters
        if (
          cp >= 0x0080 ||
          cp === 0x002d ||
          cp === 0x005f ||
          (cp >= 0x0030 && cp <= 0x0039) ||
          (cp >= 0x0041 && cp <= 0x005a) ||
          (cp >= 0x0061 && cp <= 0x007a)
        ) {
          result += str[i];
        } else {
          result += `\\${str[i]}`;
        }
      }

      return result;
    };

    Object.defineProperty(globalThis, 'CSS', {
      value: Object.assign((globalThis as Record<string, unknown>)['CSS'] ?? {}, {
        escape: cssEscapePolyfill,
      }),
      configurable: true,
      writable: true,
    });
  }

  // document.elementFromPoint polyfill — jsdom has this method but in some versions
  // it is not configurable, which prevents vi.spyOn from replacing it.
  // Re-define it as a configurable stub so tests can mock it freely.
  try {
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(document),
      'elementFromPoint',
    ) ?? Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

    if (!desc || !desc.configurable) {
      Object.defineProperty(document, 'elementFromPoint', {
        value: (_x: number, _y: number): Element | null => null,
        configurable: true,
        writable: true,
      });
    } else if (typeof document.elementFromPoint !== 'function') {
      Object.defineProperty(document, 'elementFromPoint', {
        value: (_x: number, _y: number): Element | null => null,
        configurable: true,
        writable: true,
      });
    }
  } catch {
    // If we cannot inspect the descriptor, define a safe stub
    Object.defineProperty(document, 'elementFromPoint', {
      value: (_x: number, _y: number): Element | null => null,
      configurable: true,
      writable: true,
    });
  }
}
