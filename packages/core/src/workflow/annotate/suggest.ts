import type { CapturedAction } from '@yantra/protocol';

import type { ValuePromotion } from './session.js';

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
