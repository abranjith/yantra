// @no-llm
import type { JSHandle, Page } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { collectComposedInteractables } from '../../src/discovery/composed-handles.js';

describe('@no-llm composed handle ownership', () => {
  it('disposes every acquired intermediate when record conversion fails', async () => {
    const records = handle({ jsonError: new Error('records failed') });
    const scan = handle({ properties: new Map([['records', records]]) });

    await expect(collectComposedInteractables(pageReturning(scan))).rejects.toThrow(
      'records failed',
    );
    expectDisposedOnce(scan, records);
  });

  it('disposes records and element container when property acquisition fails', async () => {
    const records = handle({ value: [] });
    const elements = handle({ propertiesError: new Error('properties failed') });
    const scan = handle({
      properties: new Map([
        ['records', records],
        ['elements', elements],
      ]),
    });

    await expect(collectComposedInteractables(pageReturning(scan))).rejects.toThrow(
      'properties failed',
    );
    expectDisposedOnce(scan, records, elements);
  });

  it('returns element handles live while disposing sparse and non-element properties', async () => {
    const records = handle({ value: [{ role: 'button', name: 'Two', elementIndex: 2 }] });
    const first = handle();
    const second = handle({ element: true });
    const metadata = handle();
    const elements = handle({
      properties: new Map([
        ['0', first],
        ['2', second],
        ['length', metadata],
      ]),
    });
    const scan = handle({
      properties: new Map([
        ['records', records],
        ['elements', elements],
      ]),
    });

    const result = await collectComposedInteractables(pageReturning(scan));

    expect(result.elements).toEqual([null, null, second]);
    expect(second.dispose).not.toHaveBeenCalled();
    expectDisposedOnce(scan, records, elements, first, metadata);
  });

  it('disposes earlier elements and all remaining properties when asElement fails partway', async () => {
    const records = handle({ value: [] });
    const acquired = handle({ element: true });
    const failing = handle({ elementError: new Error('conversion failed') });
    const trailing = handle();
    const elements = handle({
      properties: new Map([
        ['0', acquired],
        ['1', failing],
        ['2', trailing],
      ]),
    });
    const scan = handle({
      properties: new Map([
        ['records', records],
        ['elements', elements],
      ]),
    });

    await expect(collectComposedInteractables(pageReturning(scan))).rejects.toThrow(
      'conversion failed',
    );
    expectDisposedOnce(scan, records, elements, acquired, failing, trailing);
  });
});

interface FakeHandle extends JSHandle<unknown> {
  dispose: ReturnType<typeof vi.fn>;
}

function handle(
  options: {
    value?: unknown;
    jsonError?: Error;
    properties?: Map<string, FakeHandle>;
    propertiesError?: Error;
    element?: boolean;
    elementError?: Error;
  } = {},
): FakeHandle {
  const result = {
    dispose: vi.fn(async () => undefined),
    jsonValue: options.jsonError
      ? vi.fn().mockRejectedValue(options.jsonError)
      : vi.fn().mockResolvedValue(options.value),
    getProperty: vi.fn(async (name: string) => options.properties?.get(name)),
    getProperties: options.propertiesError
      ? vi.fn().mockRejectedValue(options.propertiesError)
      : vi.fn().mockResolvedValue(options.properties ?? new Map()),
    asElement: options.elementError
      ? vi.fn(() => {
          throw options.elementError;
        })
      : vi.fn(function (this: FakeHandle) {
          return options.element ? this : null;
        }),
  };
  return result as unknown as FakeHandle;
}

function pageReturning(scan: FakeHandle): Page {
  return { evaluateHandle: vi.fn().mockResolvedValue(scan) } as unknown as Page;
}

function expectDisposedOnce(...handles: FakeHandle[]): void {
  for (const owned of handles) expect(owned.dispose).toHaveBeenCalledTimes(1);
}
