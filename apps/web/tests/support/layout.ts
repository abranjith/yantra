/**
 * jsdom has no layout, so every element measures 0×0. React Aria's
 * virtualizer then has no viewport and renders every row; at 10,000 rows that
 * exhausts the worker's heap. Tests that render a virtualized collection give
 * elements a fixed size the way React Aria's own virtualizer tests do.
 */

import { afterAll, beforeAll } from 'vitest';

const NAMES = ['clientWidth', 'clientHeight'] as const;

/** Registers beforeAll/afterAll hooks that size every HTMLElement for this file. */
export function useFixedLayout(width = 1000, height = 400): void {
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeAll(() => {
    for (const name of NAMES) {
      saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      value: width,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: height,
    });
  });

  afterAll(() => {
    for (const name of NAMES) {
      const descriptor = saved.get(name);
      if (descriptor !== undefined) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      }
    }
  });
}
