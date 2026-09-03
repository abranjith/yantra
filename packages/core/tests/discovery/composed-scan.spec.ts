// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scanInteractablesInPage } from '../../src/discovery/interactable-scan.js';

function makeVisibleRect(top = 10, left = 10): DOMRect {
  return {
    top,
    left,
    bottom: top + 40,
    right: left + 100,
    width: 100,
    height: 40,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubVisible(el: Element, top = 10, left = 10): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeVisibleRect(top, left));
}

/**
 * Serialize the **composed** markup, shadow trees included.
 *
 * `outerHTML` stops at a shadow boundary, so it cannot see the mutation this
 * suite is guarding against. The point of the no-mutation assertion is that the
 * scan touches nothing anywhere it can reach — which is precisely inside the
 * shadow roots it newly walks.
 */
function composedMarkup(element: Element): string {
  const parts: string[] = [element.tagName.toLowerCase()];
  for (const attribute of Array.from(element.attributes)) {
    parts.push(`${attribute.name}=${attribute.value}`);
  }
  const shadow = element.shadowRoot;
  if (shadow) {
    parts.push('#shadow(' + Array.from(shadow.children).map(composedMarkup).join('') + ')');
  }
  for (const child of Array.from(element.children)) parts.push(composedMarkup(child));
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) parts.push(`#text(${node.nodeValue ?? ''})`);
  }
  return `<${parts.join('|')}>`;
}

/** A host whose open shadow root holds a labelled native select. */
function attachOpenSelect(host: HTMLElement, label: string, options: readonly string[]): void {
  const shadow = host.attachShadow({ mode: 'open' });
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  for (const value of options) {
    const option = document.createElement('option');
    option.textContent = value;
    select.appendChild(option);
  }
  shadow.appendChild(select);
  stubVisible(select);
}

describe('@no-llm composed-tree interactable scanning', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'visible',
      display: 'block',
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a select inside an open shadow root with its role and accessible name', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    attachOpenSelect(host, 'Delivery region', ['North', 'South']);

    const { records } = scanInteractablesInPage();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'combobox',
      kind: 'select',
      name: 'Delivery region',
      composedScope: 'open-shadow',
      rootNodeDepth: 1,
    });
  });

  it('cannot see a select inside a closed shadow root, because the platform withholds it', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Delivery region');
    shadow.appendChild(select);

    // The mechanism, stated: there is no closed-root branch in the walk — the
    // platform simply returns null, so the subtree is unreachable rather than
    // filtered. No piercing library and no DOM tagging is used to get around it.
    expect(host.shadowRoot).toBeNull();
    expect(scanInteractablesInPage().records).toEqual([]);
  });

  it('yields exactly one record for an open and a closed shadow select that a flat query misses entirely', () => {
    const openHost = document.createElement('div');
    document.body.appendChild(openHost);
    attachOpenSelect(openHost, 'Open region', ['North']);

    const closedHost = document.createElement('div');
    document.body.appendChild(closedHost);
    closedHost.attachShadow({ mode: 'closed' }).appendChild(document.createElement('select'));

    // The gap this feature closes, made concrete: the flat-tree query every
    // scanner used before sees neither control.
    expect(document.querySelectorAll('select')).toHaveLength(0);

    const { records } = scanInteractablesInPage();
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('Open region');
  });

  it('resolves aria-labelledby against the element own root, so a document id does not leak in', () => {
    // A same-valued id in the document. `document.getElementById` would find
    // this one; a root-scoped lookup must not.
    const decoy = document.createElement('span');
    decoy.id = 'field-label';
    decoy.textContent = 'Document label';
    document.body.appendChild(decoy);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('span');
    label.id = 'field-label';
    label.textContent = 'Shadow label';
    shadow.appendChild(label);
    const select = document.createElement('select');
    select.setAttribute('aria-labelledby', 'field-label');
    shadow.appendChild(select);
    stubVisible(select);

    expect(scanInteractablesInPage().records[0]?.name).toBe('Shadow label');
  });

  it('resolves label[for] against the element own root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('label');
    label.setAttribute('for', 'region');
    label.textContent = 'Shadow field label';
    shadow.appendChild(label);
    const input = document.createElement('input');
    input.id = 'region';
    shadow.appendChild(input);
    stubVisible(input);

    expect(scanInteractablesInPage().records[0]?.name).toBe('Shadow field label');
  });

  it('walks the composed ancestor chain for group and scope, crossing the shadow boundary', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Checkout options');
    document.body.appendChild(dialog);
    stubVisible(dialog, 5);

    const host = document.createElement('div');
    dialog.appendChild(host);
    attachOpenSelect(host, 'Delivery region', ['North']);

    // A `parentElement` walk terminates at the shadow boundary and would report
    // no group and page scope; the composed walk reaches the host's dialog.
    expect(scanInteractablesInPage().records[0]).toMatchObject({
      group: 'Checkout options',
      scope: 'dialog',
    });
  });

  it('returns records and elements of equal length, each record indexing its own element', () => {
    const button = document.createElement('button');
    button.textContent = 'Search';
    document.body.appendChild(button);
    stubVisible(button);

    const host = document.createElement('div');
    document.body.appendChild(host);
    attachOpenSelect(host, 'Delivery region', ['North']);

    const link = document.createElement('a');
    link.href = 'https://example.com';
    link.textContent = 'Home';
    document.body.appendChild(link);
    stubVisible(link);

    const { records, elements } = scanInteractablesInPage({ withElements: true });

    expect(records).toHaveLength(3);
    expect(elements).toHaveLength(records.length);
    // The central correctness property: the index is into the array this same
    // pass produced, so a ref can never be bound to a different element.
    for (const record of records) {
      const element = elements[record.elementIndex]!;
      expect(element.getAttribute('aria-label') ?? element.textContent).toBe(record.name);
    }
    expect(records.map((record) => record.composedScope)).toEqual([
      'document',
      'open-shadow',
      'document',
    ]);
  });

  it('omits elements entirely unless they are asked for, because a node cannot be returned by value', () => {
    const button = document.createElement('button');
    button.textContent = 'Search';
    document.body.appendChild(button);
    stubVisible(button);

    expect(scanInteractablesInPage().elements).toEqual([]);
    expect(scanInteractablesInPage({ withElements: false }).elements).toEqual([]);
    expect(scanInteractablesInPage({ withElements: true }).elements).toHaveLength(1);
  });

  it('descends into nested open shadow roots and records the boundary depth', () => {
    const outer = document.createElement('div');
    document.body.appendChild(outer);
    const outerShadow = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    outerShadow.appendChild(inner);
    attachOpenSelect(inner, 'Nested region', ['North']);

    const { records } = scanInteractablesInPage();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'Nested region', rootNodeDepth: 2 });
  });

  it('stops descending past the shadow depth cap', () => {
    let current = document.body;
    for (let depth = 0; depth < 20; depth += 1) {
      const host = document.createElement('div');
      current.appendChild(host);
      current = document.createElement('div');
      host.attachShadow({ mode: 'open' }).appendChild(current);
    }
    // The control sits 20 boundaries down, past the cap of 16.
    const deep = document.createElement('button');
    deep.textContent = 'Too deep';
    current.appendChild(deep);
    stubVisible(deep);

    expect(scanInteractablesInPage().records).toEqual([]);

    // The same control at depth 16 is still reached, so the cap is a bound
    // rather than an off-by-one that silently loses a shallower control.
    let shallow = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(shallow);
    for (let depth = 0; depth < 15; depth += 1) {
      const next = document.createElement('div');
      shallow.attachShadow({ mode: 'open' }).appendChild(next);
      shallow = next;
    }
    const reachable = document.createElement('button');
    reachable.textContent = 'Reachable';
    shallow.attachShadow({ mode: 'open' }).appendChild(reachable);
    stubVisible(reachable);

    const records = scanInteractablesInPage().records;
    expect(records).toHaveLength(1);
    expect(records[0]?.rootNodeDepth).toBe(16);
  });

  it('truncates records and elements together at the declared max', () => {
    for (let index = 0; index < 5; index += 1) {
      const button = document.createElement('button');
      button.textContent = `Button ${index}`;
      document.body.appendChild(button);
      stubVisible(button);
    }

    const { records, elements } = scanInteractablesInPage({ withElements: true, max: 3 });

    expect(records).toHaveLength(3);
    expect(elements).toHaveLength(3);
    expect(records.map((record) => record.name)).toEqual(['Button 0', 'Button 1', 'Button 2']);
  });

  it('records slotted light-DOM content exactly once', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createElement('slot'));
    // Reachable both through the host's shadow tree (via the slot) and through
    // its own light parent. Identity dedup is what keeps it recorded once.
    const slotted = document.createElement('button');
    slotted.textContent = 'Slotted action';
    host.appendChild(slotted);
    stubVisible(slotted);

    const { records } = scanInteractablesInPage();
    expect(records).toHaveLength(1);
    // Slotted content lives in the light DOM, and is reported as such.
    expect(records[0]).toMatchObject({ name: 'Slotted action', composedScope: 'document' });
  });

  it('leaves the composed markup byte-identical, because observation never mutates the page', () => {
    document.body.innerHTML =
      '<button>Search</button><div role="dialog"><a href="/x">Home</a></div>';
    const host = document.createElement('div');
    document.body.appendChild(host);
    attachOpenSelect(host, 'Delivery region', ['North', 'South']);
    for (const element of Array.from(document.body.querySelectorAll('*'))) stubVisible(element);

    const before = composedMarkup(document.documentElement);
    scanInteractablesInPage({ withElements: true });
    const after = composedMarkup(document.documentElement);

    expect(after).toBe(before);
  });
});
