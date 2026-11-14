// @no-llm
/**
 * EventInspector (FEAT-066 TASK-008): a bounded, escaped tree for any JSON.
 */

import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { EventInspector, treeEntries } from '../../src/instruments/EventInspector.js';
import { expectNoAxeViolations } from '../support/axe.js';

function keys(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-json-key]')].map(
    (node) => node.getAttribute('data-json-key') ?? '',
  );
}

describe('EventInspector', () => {
  it('lists kind, seq and ts first, then the other keys in order', () => {
    const { container } = render(
      <EventInspector value={{ zeta: 1, ts: 't', alpha: 2, kind: 'mystery', seq: 4 }} />,
    );
    expect(keys(container).slice(0, 5)).toEqual(['kind', 'seq', 'ts', 'zeta', 'alpha']);
  });

  it('renders markup in keys and values as text', () => {
    const { container } = render(
      <EventInspector value={{ '<b>key</b>': '<script>alert(1)</script>', html: '<img src=x>' }} />,
    );
    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<b>key</b>');
  });

  it('limits depth: deeper values read as a summary with an ellipsis', () => {
    let nested: unknown = { leaf: 'deep' };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    const { container } = render(<EventInspector value={nested} maxDepth={6} expandedDepth={10} />);
    expect(container.textContent).not.toContain('deep');
    expect(container.textContent).toContain('{1} …');
  });

  it('limits breadth to 200 entries per level, then "+N more"', () => {
    const wide = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${String(i)}`, i]));
    const { container } = render(<EventInspector value={wide} />);
    expect(keys(container)).toHaveLength(200);
    expect(screen.getByText('+50 more')).toBeTruthy();
  });

  it('collapses strings over 2 KiB until asked', async () => {
    const long = 'y'.repeat(5_000);
    const { container } = render(<EventInspector value={{ blob: long }} />);
    expect(container.textContent).not.toContain(long);
    await userEvent.click(screen.getByRole('button', { name: /Show all/u }));
    expect(container.textContent).toContain(long);
  });

  it('renders scalars, null and arrays', () => {
    const { container } = render(
      <EventInspector value={{ n: 1, b: false, z: null, list: [1, 2] }} />,
    );
    expect(container.textContent).toContain('n: 1');
    expect(container.textContent).toContain('b: false');
    expect(container.textContent).toContain('z: null');
    expect(container.textContent).toContain('[2]');
  });

  it('orders and caps entries without a DOM', () => {
    expect(
      treeEntries({ b: 1, kind: 'k', a: 2 }, { maxEntries: 2, priorityKeys: ['kind'] }),
    ).toEqual({
      entries: [
        ['kind', 'k'],
        ['b', 1],
      ],
      hidden: 1,
    });
    expect(treeEntries([1, 2, 3], { maxEntries: 5, priorityKeys: [] }).entries).toHaveLength(3);
  });

  it('has an accessible name and no axe violations', async () => {
    const { container } = render(
      <EventInspector value={{ kind: 'x', nested: { a: 1 } }} label="Line 3 details" />,
    );
    expect(screen.getByRole('group', { name: 'Line 3 details' })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
