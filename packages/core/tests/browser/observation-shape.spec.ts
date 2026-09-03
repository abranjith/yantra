import { describe, expect, it } from 'vitest';

import { projectAgentInteractable } from '../../src/browser/agent-controller.js';
import type { RawInteractable } from '../../src/discovery/interactable-scan.js';

function raw(overrides: Partial<RawInteractable> = {}): RawInteractable {
  return {
    role: 'button',
    name: 'Go',
    kind: 'button',
    disabled: false,
    top: 0,
    left: 0,
    group: null,
    scope: 'page',
    value: null,
    valuePresent: false,
    checked: null,
    expanded: null,
    selected: null,
    visible: true,
    elementIndex: 0,
    composedScope: 'document',
    rootNodeDepth: 0,
    focused: false,
    container: null,
    ...overrides,
  };
}

describe('@no-llm agent observation projection', () => {
  it('keeps a plain enabled element at the minimal three-key shape', () => {
    expect(projectAgentInteractable('e1', raw())).toEqual({
      ref: 'e1',
      role: 'button',
      name: 'Go',
    });
  });

  it('projects useful widget state without falsey noise', () => {
    expect(
      projectAgentInteractable(
        'e2',
        raw({
          group: 'August 2026',
          disabled: true,
          value: 'Frisco, Texas',
          valuePresent: true,
          checked: false,
          expanded: false,
          selected: true,
        }),
      ),
    ).toEqual({
      ref: 'e2',
      role: 'button',
      name: 'Go',
      group: 'August 2026',
      disabled: true,
      value: 'Frisco, Texas',
      value_present: true,
      expanded: false,
      selected: true,
    });
  });

  it('projects no internal traversal field, whatever the scan recorded', () => {
    // `browser-common.ts` forwards `observation.interactables` to the model
    // wholesale, so anything the projection lets through is a model-visible
    // payload contract change — and costs every observation bytes for a
    // diagnostic. The allow-list is what keeps that from happening by
    // accident; this asserts the allow-list actually holds.
    const projected = projectAgentInteractable(
      'e3',
      raw({
        composedScope: 'open-shadow',
        rootNodeDepth: 2,
        elementIndex: 7,
        focused: true,
        container: { role: 'dialog', name: 'Cookie choices' },
      }),
    );

    expect(Object.keys(projected)).toEqual(['ref', 'role', 'name']);
    for (const internal of [
      'composedScope',
      'rootNodeDepth',
      'elementIndex',
      'selectorIndex',
      'focused',
      'container',
    ]) {
      expect(JSON.stringify(projected)).not.toContain(internal);
    }
  });
});
