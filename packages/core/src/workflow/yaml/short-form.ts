import type { WorkflowStep } from '@yantra/protocol';

type ShorthandVerb = 'navigate' | 'click' | 'fill' | 'wait_for';

/**
 * Convert a WorkflowStep to a YAML shorthand node.
 * Falls back to canonical form if shorthand would lose information.
 */
export function toShortForm(step: WorkflowStep): Record<string, unknown> {
  if (step.scope !== null) {
    return stepToCanonical(step);
  }

  switch (step.verb) {
    case 'navigate':
      return { id: step.id, navigate: step.url };

    case 'click':
      return { id: step.id, click: step.locator };

    case 'fill': {
      if (step.submit) {
        return stepToCanonical(step);
      }
      return { id: step.id, fill: { to: step.locator, value: step.value } };
    }

    case 'wait_for': {
      if (step.state !== 'visible' || step.timeout_ms !== null) {
        return stepToCanonical(step);
      }
      return { id: step.id, wait_for: step.locator };
    }

    default:
      return stepToCanonical(step);
  }
}

function stepToCanonical(step: WorkflowStep): Record<string, unknown> {
  return step;
}

/**
 * Convert a YAML node (parsed from YAML) to a canonical WorkflowStep input (pre-Zod).
 * Detects shorthand by checking if node has a shorthand key.
 * @param node - The parsed YAML node for a single step
 * @param index - The 0-based position in the steps array (used for auto-ID assignment)
 */
export function fromShortForm(node: unknown, index: number): unknown {
  if (typeof node !== 'object' || node === null) return node;

  const obj = node as Record<string, unknown>;
  const autoId = `s${index + 1}`;

  // Detect navigate shorthand: { id?, navigate: url }
  if ('navigate' in obj && typeof obj.navigate !== 'undefined') {
    const isShorthand = !('verb' in obj);
    if (isShorthand) {
      return {
        verb: 'navigate',
        id: obj.id ?? autoId,
        url: obj.navigate,
        scope: null,
      };
    }
  }

  // Detect click shorthand: { id?, click: locatorName }
  if ('click' in obj && typeof obj.click === 'string') {
    const isShorthand = !('verb' in obj);
    if (isShorthand) {
      return {
        verb: 'click',
        id: obj.id ?? autoId,
        locator: obj.click,
        scope: null,
      };
    }
  }

  // Detect fill shorthand: { id?, fill: { to: locator, value: expr } }
  if (
    'fill' in obj &&
    typeof obj.fill === 'object' &&
    obj.fill !== null &&
    'to' in (obj.fill as Record<string, unknown>)
  ) {
    const isShorthand = !('verb' in obj);
    if (isShorthand) {
      const fillNode = obj.fill as Record<string, unknown>;
      return {
        verb: 'fill',
        id: obj.id ?? autoId,
        locator: fillNode.to,
        value: fillNode.value ?? null,
        submit: false,
        scope: null,
      };
    }
  }

  // Detect wait_for shorthand: { id?, wait_for: locatorName }
  if ('wait_for' in obj && typeof obj.wait_for === 'string') {
    const isShorthand = !('verb' in obj);
    if (isShorthand) {
      return {
        verb: 'wait_for',
        id: obj.id ?? autoId,
        locator: obj.wait_for,
        state: 'visible',
        timeout_ms: null,
        scope: null,
      };
    }
  }

  // Canonical form — assign auto-ID if missing
  if (!('id' in obj)) {
    return { ...obj, id: autoId };
  }

  return node;
}

export type { ShorthandVerb };
