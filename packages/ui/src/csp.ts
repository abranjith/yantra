/**
 * Keeping React Aria inside a strict Content-Security-Policy.
 *
 * React Aria's `usePress` injects `<style id="react-aria-pressable-style">`
 * (a `touch-action` rule) at runtime. The app's CSP is `default-src 'self'`
 * with no nonce (plan_ui §7), so that inline style is blocked and reported as
 * a violation. React Aria skips the injection when an element with that id
 * already exists, so Drshya ships the same rule in `drshya.css` and places a
 * non-style marker with that id before the first render.
 *
 * Call {@link prepareStrictCsp} once, before rendering (the gallery page
 * does; FEAT-065's app shell must too). The real-Chrome harness fails on any
 * CSP violation, which is what catches a React Aria upgrade that renames the id.
 */

/** React Aria's id for its injected pressable style (react-aria 3.53). */
export const REACT_ARIA_PRESSABLE_STYLE_ID = 'react-aria-pressable-style';

/** Places the marker that stops React Aria injecting an inline `<style>`. */
export function prepareStrictCsp(doc: Document): void {
  if (doc.getElementById(REACT_ARIA_PRESSABLE_STYLE_ID) !== null) {
    return;
  }
  const marker = doc.createElement('meta');
  marker.id = REACT_ARIA_PRESSABLE_STYLE_ID;
  marker.name = 'drshya-pressable-style';
  marker.content = 'Provided by @yantra/ui/drshya.css';
  doc.head.append(marker);
}
