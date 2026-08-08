import type { WidgetPort } from './types.js';

/** Temporary attribute used only while resolving an in-page widget target. */
export const WIDGET_TARGET_ATTRIBUTE = 'data-yantra-widget-target';

/**
 * Tag an in-page target, resolve it back to an opaque ref, run `body`, and
 * remove the tag even when resolution or the body throws.
 *
 * `inPageSelectorFn` receives the attribute name and unique token. It must
 * locate the intended element, set that attribute to the token, and return
 * true; returning false reports an unreachable target.
 */
export async function withTag<T, Args extends readonly unknown[] = readonly []>(
  port: WidgetPort,
  inPageSelectorFn: (attribute: string, token: string, ...args: Args) => boolean,
  body: (ref: string) => Promise<T>,
  ...args: Args
): Promise<T> {
  const token = `yantra-${Math.random().toString(36).slice(2)}-${port.now()}`;
  try {
    const tagged = await port.evaluate(inPageSelectorFn, WIDGET_TARGET_ATTRIBUTE, token, ...args);
    if (!tagged) throw new Error('Widget target could not be tagged in the live page.');
    const observation = await port.observe({ cap: 400, trackDigest: false });
    const matches: string[] = [];
    for (const candidate of observation.interactables) {
      const ownsTag = await port.evaluateOn(
        candidate.ref,
        (element, attribute, expected) => element.getAttribute(attribute) === expected,
        WIDGET_TARGET_ATTRIBUTE,
        token,
      );
      if (ownsTag) matches.push(candidate.ref);
    }
    if (matches.length !== 1) {
      throw new Error(`Tagged widget target resolved to ${matches.length} opaque refs.`);
    }
    return await body(matches[0]!);
  } finally {
    await port.evaluate(
      (attribute, expected) => {
        for (const element of document.querySelectorAll(`[${attribute}]`)) {
          if (element.getAttribute(attribute) === expected) element.removeAttribute(attribute);
        }
      },
      WIDGET_TARGET_ATTRIBUTE,
      token,
    );
  }
}
