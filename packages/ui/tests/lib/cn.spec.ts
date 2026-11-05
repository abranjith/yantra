import { describe, expect, it } from 'vitest';

import { cn, focusRing, tv } from '../../src/lib/cn.js';

describe('@no-llm Drshya cn', () => {
  it('lets a later semantic color replace an earlier one', () => {
    expect(cn('text-ink', 'text-ink-2')).toBe('text-ink-2');
    expect(cn('bg-surface', 'bg-sunken')).toBe('bg-sunken');
    expect(cn('border-rule', 'border-field-edge')).toBe('border-field-edge');
  });

  it('keeps a color and a type size together', () => {
    expect(cn('text-ink-2', 'text-body')).toBe('text-ink-2 text-body');
    expect(cn('text-caption', 'text-signal-failed-ink')).toBe(
      'text-caption text-signal-failed-ink',
    );
  });

  it('lets a later type size replace an earlier one', () => {
    expect(cn('text-body', 'text-caption')).toBe('text-caption');
  });

  it('merges Drshya radii', () => {
    expect(cn('rounded-chip', 'rounded-control')).toBe('rounded-control');
    expect(cn('rounded-frame', 'rounded-full')).toBe('rounded-full');
  });

  it('treats each signal and ink as a color', () => {
    expect(cn('text-signal-fulfilled-ink', 'text-accent-ink')).toBe('text-accent-ink');
    expect(cn('outline-accent', 'outline-field-edge')).toBe('outline-field-edge');
  });

  it('keeps state variants independent', () => {
    expect(cn('bg-surface', 'hover:bg-sunken')).toBe('bg-surface hover:bg-sunken');
  });

  it('ignores falsy inputs', () => {
    expect(cn('text-ink', false, undefined, null, '', 'p-2')).toBe('text-ink p-2');
  });
});

describe('@no-llm Drshya tv', () => {
  it('resolves variant conflicts with the Drshya merger', () => {
    const recipe = tv({
      base: 'text-ink text-body',
      variants: { tone: { muted: 'text-ink-2' } },
    });

    expect(recipe({ tone: 'muted' })).toBe('text-body text-ink-2');
  });

  it('lets a caller className override a recipe color', () => {
    const recipe = tv({ base: 'bg-surface p-2' });

    expect(recipe({ className: 'bg-sunken' })).toBe('p-2 bg-sunken');
  });

  it('exposes a focus ring that only shows for keyboard focus', () => {
    const ring = focusRing();

    expect(ring).toContain('outline-hidden');
    expect(ring).toContain('focus-visible:outline-solid');
    expect(ring).toContain('focus-visible:outline-2');
    expect(ring).toContain('focus-visible:outline-offset-2');
    expect(ring).toContain('focus-visible:outline-accent');
  });
});
