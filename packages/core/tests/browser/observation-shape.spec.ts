import { describe, expect, it } from 'vitest';

import { projectAgentInteractable } from '../../src/browser/agent-controller.js';
import type { RawInteractable } from '../../src/discovery/interactable-scan.js';
import { INTERACTABLE_ENTRY_MAX_BYTES } from '../../src/interaction/field-identity.js';

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
    withheldReason: null,
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
  it('pins identity and whole-entry UTF-8 budgets with reserved withheld headroom', () => {
    const entry = projectAgentInteractable(
      'e200',
      raw({
        role: 'textbox',
        name: '界'.repeat(200),
        value: '界'.repeat(120),
        group: '界'.repeat(60),
        field: {
          explicit: null,
          structural: { text: '界'.repeat(80), source: 'wrapper', adjacent: true },
          section: '界'.repeat(60),
          inputType: 'email',
          autocomplete: 'email',
          required: true,
          maxLength: 100,
          pattern: '.'.repeat(40),
          htmlName: 'name',
          htmlId: 'field',
          placeholder: null,
          selectPlaceholder: null,
          title: null,
          radioGroup: null,
          checkboxSet: null,
          humanVerification: false,
          hiddenInput: false,
          disabled: false,
          readOnly: false,
        },
      }),
    );
    expect(Object.keys(entry.field!)).toEqual(
      expect.arrayContaining(['origin', 'confidence', 'label']),
    );
    expect(Buffer.byteLength(JSON.stringify(entry.field))).toBeLessThanOrEqual(256);
    expect(
      Buffer.byteLength(JSON.stringify({ ...entry, withheld: 'x'.repeat(32) })),
    ).toBeLessThanOrEqual(768);
    expect(entry.field).not.toHaveProperty('hint');
  });
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

  it('says why a value is withheld, beside value_present, and only when it is', () => {
    expect(
      projectAgentInteractable(
        'e4',
        raw({ role: 'textbox', name: 'Password', valuePresent: true, withheldReason: 'password' }),
      ),
    ).toEqual({
      ref: 'e4',
      role: 'textbox',
      name: 'Password',
      value_present: true,
      withheld: 'password',
    });
    // Withheld and empty: the reason still stands, presence does not.
    expect(
      projectAgentInteractable('e5', raw({ role: 'textbox', withheldReason: 'autocomplete' })),
    ).toEqual({ ref: 'e5', role: 'textbox', name: 'Go', withheld: 'autocomplete' });
    expect(
      projectAgentInteractable('e6', raw({ role: 'textbox', value: 'Lyon' })),
    ).not.toHaveProperty('withheld');
  });

  it('keeps the worst-case entry carrying the longest withheld reason inside the entry budget', () => {
    // The longest reason costs `,"withheld":"secret_marker"` — 27 bytes, inside
    // the headroom the identity budget reserves for it.
    expect(Buffer.byteLength(',"withheld":"secret_marker"', 'utf8')).toBe(27);
    const entry = projectAgentInteractable(
      'e200',
      raw({
        role: 'textbox',
        name: '界'.repeat(200),
        value: null,
        valuePresent: true,
        withheldReason: 'secret_marker',
        group: '界'.repeat(60),
        field: {
          explicit: null,
          structural: { text: '界'.repeat(80), source: 'wrapper', adjacent: true },
          section: '界'.repeat(60),
          inputType: 'password',
          autocomplete: 'current-password',
          required: true,
          maxLength: 100,
          pattern: '.'.repeat(40),
          htmlName: 'name',
          htmlId: 'field',
          placeholder: null,
          selectPlaceholder: null,
          title: null,
          radioGroup: null,
          checkboxSet: null,
          humanVerification: false,
          hiddenInput: false,
          disabled: false,
          readOnly: false,
        },
      }),
    );
    expect(entry.withheld).toBe('secret_marker');
    expect(entry.value_present).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(
      INTERACTABLE_ENTRY_MAX_BYTES,
    );
  });
});
