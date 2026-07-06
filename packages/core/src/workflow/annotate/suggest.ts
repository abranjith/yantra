import type { CapturedAction } from '@yantra/protocol';

import type { ValuePromotion } from './session.js';

/** Heuristic: button text or accessible name that looks like a purchase/submit action. */
const PURCHASE_SHAPED_PATTERN =
  /\b(buy|pay|book|order|submit|purchase|checkout|confirm|place\s+order|complete\s+purchase)\b/i;

/**
 * Suggest a human-readable locator name for a captured action. Pure function.
 */
export function suggestLocatorName(action: CapturedAction): string | null {
  if (action.kind === 'navigate') return null;
  if (action.kind === 'wait') return null;

  const desc = action.element_descriptor;

  // Use accessible name if available
  if (desc.accessible_name && desc.accessible_name.trim().length > 0) {
    const name = desc.accessible_name.trim().slice(0, 50);
    if (desc.role === 'button') return `${name} button`;
    if (desc.role === 'textbox' || desc.role === 'combobox') return `${name} field`;
    if (desc.role === 'link') return `${name} link`;
    if (desc.role === 'checkbox') return `${name} checkbox`;
    if (desc.role === 'radio') return `${name} radio`;
    return name;
  }

  // Use placeholder
  const placeholder = desc.attrs_sample.placeholder;
  if (placeholder) {
    const name = placeholder.trim().slice(0, 50);
    return `${name} field`;
  }

  // Use aria-label
  const ariaLabel = desc.attrs_sample['aria-label'];
  if (ariaLabel) {
    const name = ariaLabel.trim().slice(0, 50);
    if (desc.role === 'button') return `${name} button`;
    return name;
  }

  // Use visible text
  if (desc.visible_text && desc.visible_text.trim().length > 0) {
    const text = desc.visible_text.trim().slice(0, 40);
    if (desc.role === 'button') return `${text} button`;
    if (desc.role === 'link') return `${text} link`;
    return text;
  }

  // Fallback: role + tag
  if (desc.role) {
    return `${desc.role} ${desc.tag}`;
  }

  return `${desc.tag} element`;
}

/**
 * Suggest whether a captured action should require human confirmation.
 *
 * Returns `true` for click actions whose accessible name, visible text, or
 * role matches the purchase-shaped heuristic (buy, pay, book, order, submit,
 * etc.). Returns `false` for all other actions.
 */
export function suggestRequiresConfirmation(action: CapturedAction): boolean {
  if (action.kind !== 'click') return false;

  const desc = action.element_descriptor;
  const textToCheck = [desc.accessible_name, desc.visible_text, desc.attrs_sample['aria-label']]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');

  return PURCHASE_SHAPED_PATTERN.test(textToCheck);
}

/**
 * Suggest a value promotion heuristic.
 */
export function suggestValuePromotion(action: CapturedAction): ValuePromotion {
  if (action.kind !== 'fill') return null;

  switch (action.input_type) {
    case 'password':
      return 'secret';
    case 'email':
      return 'param';
    case 'text':
    case 'tel':
    case 'number':
    case 'url':
    case 'search':
    case 'textarea':
    case 'other':
    default:
      return 'literal';
  }
}
