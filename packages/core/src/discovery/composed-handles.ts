import type { ElementHandle, JSHandle, Page as PuppeteerPage } from 'puppeteer-core';

import { scanInteractablesInPage, type RawInteractable } from './interactable-scan.js';

/** One composed-tree pass, returned as live handles plus their records. */
export interface ComposedInteractables {
  /**
   * Described records for the candidates the projection has a kind for.
   *
   * Each carries an `elementIndex` into {@link ComposedInteractables.elements}.
   * Empty for a caller that supplied its own `selector` and describes the
   * handles itself.
   */
  readonly records: readonly RawInteractable[];
  /**
   * Live handles for every candidate the walk reached, in `elementIndex` order.
   *
   * A slot may be `null` only if the page returned a non-element there, which
   * the walk does not produce; the type admits it so an index never silently
   * shifts to cover a gap.
   */
  readonly elements: readonly (ElementHandle<Element> | null)[];
}

/**
 * Collect interactable candidates and their handles from **one** composed-tree
 * pass, walking through open shadow roots.
 *
 * This is the single handle-collection implementation. Both the agent
 * controller and the deterministic replay port use it, which is the point: the
 * arrangement it replaces paired a record list from one traversal with a handle
 * list from an independent `page.$$`, held in step only by a doc comment
 * demanding two selector constants stay byte-identical. That kind of drift does
 * not fail loudly — it silently binds every ref to the wrong element.
 *
 * Callers keep their own membership question through `selector` and their own
 * projection; only the walk is shared.
 *
 * Every handle returned belongs to the caller, which must dispose the ones it
 * does not keep. Handles are released here only on a failed collection.
 */
export async function collectComposedInteractables(
  page: PuppeteerPage,
  options: { readonly max: number; readonly selector?: string } = { max: 400 },
): Promise<ComposedInteractables> {
  const scanHandle = await page.evaluateHandle(scanInteractablesInPage, {
    withElements: true,
    max: options.max,
    ...(options.selector === undefined ? {} : { selector: options.selector }),
  });
  const elements: (ElementHandle<Element> | null)[] = [];
  try {
    const recordsHandle = await scanHandle.getProperty('records');
    const records = await recordsHandle.jsonValue();
    release(recordsHandle);
    const elementsHandle = await scanHandle.getProperty('elements');
    const properties = await elementsHandle.getProperties();
    const length = properties.size;
    // Indexed by the numeric string key rather than by iteration order: the
    // correspondence records rely on is positional, and trusting a map's order
    // to reproduce it would reintroduce the coupling this pass removes.
    for (let index = 0; index < length; index += 1) {
      const property = properties.get(String(index));
      const element = (property?.asElement() as ElementHandle<Element> | null) ?? null;
      elements.push(element);
      if (property && !element) release(property);
    }
    for (const [key, property] of properties) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= length) release(property);
    }
    release(elementsHandle);
    return { records, elements };
  } catch (error) {
    for (const element of elements) if (element) release(element);
    throw error;
  } finally {
    release(scanHandle);
  }
}

function release(handle: JSHandle<unknown>): void {
  void Promise.resolve(handle.dispose()).catch(() => undefined);
}
