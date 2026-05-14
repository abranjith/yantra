/// <reference lib="dom" />

/**
 * XPath strategy: query by expression + absolute path generator.
 *
 * This is the last-resort locator strategy — generated at record time
 * and stored as the final fallback. Absolute XPath is the MOST brittle
 * candidate; it breaks on any DOM restructuring.
 */

/**
 * Queries the document using an XPath expression.
 *
 * @param expression - XPath expression (e.g. /html/body/div[2]/button[1])
 * @returns All matching elements in document order
 * @throws {SyntaxError} when the expression is invalid
 */
export function queryXpath(expression: string): Element[] {
  let result: XPathResult;
  try {
    result = document.evaluate(
      expression,
      document,
      null,
      XPathResult.ORDERED_NODE_ITERATOR_TYPE,
      null,
    );
  } catch (err) {
    throw new SyntaxError(
      `Invalid XPath expression: ${expression} — ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const elements: Element[] = [];
  let node = result.iterateNext();
  while (node !== null) {
    if (node instanceof Element) {
      elements.push(node);
    }
    node = result.iterateNext();
  }
  return elements;
}

/**
 * Generates an absolute XPath path for the given element.
 *
 * Walks the parentNode chain to <html>, emitting `/tagname[n]` segments.
 * No optimization, no shortcuts — this is the last resort.
 *
 * @param el - The element to generate an XPath for
 * @returns Absolute XPath string (e.g. /html/body/div[2]/button[1])
 */
export function generateAbsoluteXpath(el: Element): string {
  const segments: string[] = [];
  let current: Node | null = el;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const elem = current as Element;
    const tag = elem.tagName.toLowerCase();
    const index = getSiblingIndex(elem);
    segments.unshift(`${tag}[${index}]`);
    current = current.parentNode;
  }

  return '/' + segments.join('/');
}

/** Returns the 1-based position of the element among same-tag siblings. */
function getSiblingIndex(el: Element): number {
  const tag = el.tagName;
  let index = 1;
  let sibling = el.previousElementSibling;

  while (sibling !== null) {
    if (sibling.tagName === tag) index++;
    sibling = sibling.previousElementSibling;
  }

  return index;
}
