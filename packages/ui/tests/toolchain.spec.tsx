import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { version } from 'react';
import { Button } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';

import { DRSHYA_PACKAGE } from '../src/index.js';

import { cssEscape } from './support/css-escape.js';
import { setMatchMedia } from './support/match-media.js';

describe('@no-llm Drshya toolchain', () => {
  it('renders a React Aria Button in jsdom with its accessible name', () => {
    render(<Button>Stop run</Button>);

    expect(screen.getByRole('button', { name: 'Stop run' })).toBeDefined();
  });

  it('drives React Aria press handling with user-event', async () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Retry</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('runs on React 19', () => {
    expect(version.split('.')[0]).toBe('19');
  });

  it('exports the package entry point', () => {
    expect(DRSHYA_PACKAGE).toBe('@yantra/ui');
  });

  it('provides CSS.escape for React Aria collections', () => {
    expect(cssEscape('react-aria-1')).toBe('react-aria-1');
    expect(cssEscape('a b')).toBe('a\\ b');
    expect(cssEscape('1x')).toBe('\\31 x');
    expect(cssEscape('-')).toBe('\\-');
    expect(CSS.escape('a:b')).toBe('a\\:b');
  });

  it('stubs matchMedia with a controllable implementation', () => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = vi.fn();
    query.addEventListener('change', onChange);

    expect(query.matches).toBe(false);

    setMatchMedia({ 'prefers-color-scheme: dark': true });

    expect(query.matches).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
  });
});
