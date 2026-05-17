// @no-llm
import type { WorkflowStep } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { toShortForm, fromShortForm } from '../../../src/workflow/yaml/short-form.js';

describe('toShortForm', () => {
  it('converts navigate step to shorthand', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'navigate',
      url: 'https://example.com',
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['navigate']).toBe('https://example.com');
    expect(short['verb']).toBeUndefined();
  });

  it('converts click step to shorthand', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'click',
      locator: 'Submit button',
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['click']).toBe('Submit button');
    expect(short['verb']).toBeUndefined();
  });

  it('converts fill step to shorthand when submit is false', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'fill',
      locator: 'Username field',
      value: '{{ param:username }}',
      submit: false,
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['fill']).toEqual({ to: 'Username field', value: '{{ param:username }}' });
  });

  it('converts wait_for step to shorthand when state is visible and no timeout', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'wait_for',
      locator: 'Dashboard heading',
      state: 'visible',
      timeout_ms: null,
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['wait_for']).toBe('Dashboard heading');
  });

  it('falls back to canonical for fill with submit:true', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'fill',
      locator: 'Username field',
      value: 'user@example.com',
      submit: true,
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['verb']).toBe('fill');
    expect(short['submit']).toBe(true);
  });

  it('falls back to canonical for wait_for with non-visible state', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'wait_for',
      locator: 'Loading spinner',
      state: 'hidden',
      timeout_ms: null,
      scope: null,
    };
    const short = toShortForm(step);
    expect(short['verb']).toBe('wait_for');
    expect(short['state']).toBe('hidden');
  });

  it('falls back to canonical for step with non-null scope', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'navigate',
      url: 'https://example.com',
      scope: 'read-only-data',
    };
    const short = toShortForm(step);
    expect(short['verb']).toBe('navigate');
    expect(short['scope']).toBe('read-only-data');
  });

  it('uses canonical for extract, assert, branch, loop, call_workflow, llm_summarize', () => {
    const extractStep: WorkflowStep = {
      id: 's1',
      verb: 'extract',
      locator: 'Data table',
      extraction_schema: { type: 'primitive', kind: 'string' },
      capture_as: 'result',
      scope: null,
    };
    const short = toShortForm(extractStep);
    expect(short['verb']).toBe('extract');
  });
});

describe('fromShortForm', () => {
  it('converts navigate shorthand to canonical', () => {
    const node = { navigate: 'https://example.com' };
    const result = fromShortForm(node, 0) as Record<string, unknown>;
    expect(result['verb']).toBe('navigate');
    expect(result['url']).toBe('https://example.com');
    expect(result['id']).toBe('s1');
    expect(result['scope']).toBeNull();
  });

  it('converts click shorthand to canonical', () => {
    const node = { click: 'Sign in button' };
    const result = fromShortForm(node, 1) as Record<string, unknown>;
    expect(result['verb']).toBe('click');
    expect(result['locator']).toBe('Sign in button');
    expect(result['id']).toBe('s2');
  });

  it('converts fill shorthand to canonical', () => {
    const node = { fill: { to: 'Username field', value: 'user@example.com' } };
    const result = fromShortForm(node, 0) as Record<string, unknown>;
    expect(result['verb']).toBe('fill');
    expect(result['locator']).toBe('Username field');
    expect(result['value']).toBe('user@example.com');
    expect(result['submit']).toBe(false);
  });

  it('converts wait_for shorthand to canonical', () => {
    const node = { wait_for: 'Dashboard heading' };
    const result = fromShortForm(node, 2) as Record<string, unknown>;
    expect(result['verb']).toBe('wait_for');
    expect(result['locator']).toBe('Dashboard heading');
    expect(result['state']).toBe('visible');
    expect(result['timeout_ms']).toBeNull();
    expect(result['id']).toBe('s3');
  });

  it('passes through canonical form unchanged', () => {
    const node = {
      verb: 'click',
      id: 's5',
      locator: 'Submit',
      scope: null,
    };
    const result = fromShortForm(node, 0) as Record<string, unknown>;
    expect(result['verb']).toBe('click');
    expect(result['id']).toBe('s5');
  });

  it('preserves explicit id from shorthand node', () => {
    const node = { id: 's99', navigate: 'https://example.com' };
    const result = fromShortForm(node, 0) as Record<string, unknown>;
    expect(result['id']).toBe('s99');
  });

  it('auto-assigns id based on index when missing from canonical', () => {
    const node = { verb: 'navigate', url: 'https://example.com', scope: null };
    const result = fromShortForm(node, 4) as Record<string, unknown>;
    expect(result['id']).toBe('s5');
  });
});

describe('toShortForm → fromShortForm roundtrip', () => {
  it('roundtrips navigate step', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'navigate',
      url: 'https://example.com',
      scope: null,
    };
    const short = toShortForm(step);
    const canonical = fromShortForm(short, 0) as Record<string, unknown>;
    expect(canonical['verb']).toBe('navigate');
    expect(canonical['url']).toBe('https://example.com');
  });

  it('roundtrips click step', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'click',
      locator: 'My button',
      scope: null,
    };
    const short = toShortForm(step);
    const canonical = fromShortForm(short, 0) as Record<string, unknown>;
    expect(canonical['verb']).toBe('click');
    expect(canonical['locator']).toBe('My button');
  });

  it('roundtrips fill step with null scope', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'fill',
      locator: 'Email field',
      value: '{{ param:email }}',
      submit: false,
      scope: null,
    };
    const short = toShortForm(step);
    const canonical = fromShortForm(short, 0) as Record<string, unknown>;
    expect(canonical['verb']).toBe('fill');
    expect(canonical['locator']).toBe('Email field');
    expect(canonical['value']).toBe('{{ param:email }}');
    expect(canonical['submit']).toBe(false);
  });

  it('roundtrips wait_for step with defaults', () => {
    const step: WorkflowStep = {
      id: 's1',
      verb: 'wait_for',
      locator: 'Page heading',
      state: 'visible',
      timeout_ms: null,
      scope: null,
    };
    const short = toShortForm(step);
    const canonical = fromShortForm(short, 0) as Record<string, unknown>;
    expect(canonical['verb']).toBe('wait_for');
    expect(canonical['locator']).toBe('Page heading');
    expect(canonical['state']).toBe('visible');
    expect(canonical['timeout_ms']).toBeNull();
  });

  it('property: navigate urls roundtrip losslessly', () => {
    fc.assert(
      fc.property(fc.webUrl({ withFragments: false, withQueryParameters: true }), (url) => {
        const step: WorkflowStep = { id: 's1', verb: 'navigate', url, scope: null };
        const short = toShortForm(step);
        const canonical = fromShortForm(short, 0) as Record<string, unknown>;
        return canonical['url'] === url && canonical['verb'] === 'navigate';
      }),
    );
  });

  it('property: locator names roundtrip losslessly for click', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        (locatorName) => {
          const step: WorkflowStep = { id: 's1', verb: 'click', locator: locatorName, scope: null };
          const short = toShortForm(step);
          const canonical = fromShortForm(short, 0) as Record<string, unknown>;
          return canonical['locator'] === locatorName && canonical['verb'] === 'click';
        },
      ),
    );
  });
});
