/** @no-llm composed-tree hit testing at one exact click point. */

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { hitTestAtPoint, OVERLAY_ANCESTRY } from '../../src/index.js';

/** A document whose `elementFromPoint` answers whatever the test decides. */
function page(html: string): {
  readonly document: Document;
  topmost(element: Element | null): void;
} {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const { document } = dom.window;
  let hit: Element | null = null;
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => hit,
    configurable: true,
    writable: true,
  });
  return {
    document,
    topmost: (element) => {
      hit = element;
    },
  };
}

const at = (element: Element): ReturnType<typeof hitTestAtPoint> =>
  hitTestAtPoint(element, 10, 20, OVERLAY_ANCESTRY);

describe('@no-llm hitTestAtPoint reachability', () => {
  it('reports reachable when the hit node is the target itself', () => {
    const { document, topmost } = page('<button id="go">Go</button>');
    const target = document.querySelector('#go')!;
    topmost(target);
    expect(at(target)).toEqual({ reachable: true });
  });

  it('reports reachable when the hit node is a descendant of the target', () => {
    const { document, topmost } = page('<button id="go"><span id="label">Go</span></button>');
    const target = document.querySelector('#go')!;
    topmost(document.querySelector('#label'));
    expect(at(target)).toEqual({ reachable: true });
  });

  it('reports reachable through an open shadow boundary via the host', () => {
    const { document, topmost } = page('<div id="host"></div>');
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button id="inner">Inner</button>';
    const inner = shadow.querySelector('#inner')!;
    // `elementFromPoint` on the document stops at the host; the probe descends
    // the open root, and the walk back up reaches the target through it.
    Object.defineProperty(shadow, 'elementFromPoint', {
      value: () => inner,
      configurable: true,
      writable: true,
    });
    topmost(host);
    expect(at(host)).toEqual({ reachable: true });
    expect(at(inner)).toEqual({ reachable: true });
  });

  it('reports reachable when nothing at all is at the point', () => {
    // No evidence of an overlay: there is no container to name and no dismissal
    // to offer, so the existing stale/hidden recovery owns the case instead.
    const { document, topmost } = page('<button id="go">Go</button>');
    topmost(null);
    expect(at(document.querySelector('#go')!)).toEqual({ reachable: true });
  });

  it('reports intercepted when a sibling covers the point', () => {
    const { document, topmost } = page(
      '<button id="go">Go</button><div id="cover" style="position:fixed">Cover</div>',
    );
    topmost(document.querySelector('#cover'));
    const result = at(document.querySelector('#go')!);
    expect(result.reachable).toBe(false);
    if (result.reachable) throw new Error('expected interception');
    expect(result.chain[0]).toMatchObject({ role: 'div', name: 'Cover', position: 'fixed' });
  });
});

describe('@no-llm hitTestAtPoint chain summaries', () => {
  it('collects composed ancestors with the facts classification needs', () => {
    const { document, topmost } = page(
      '<button id="go">Go</button>' +
        '<div id="scrim" aria-modal="true" role="dialog" aria-label="Cookie choices" style="position:fixed">' +
        '<div id="body"><span id="text">We use cookies</span></div></div>',
    );
    topmost(document.querySelector('#text'));
    const result = at(document.querySelector('#go')!);
    if (result.reachable) throw new Error('expected interception');
    expect(result.chain).toHaveLength(OVERLAY_ANCESTRY);
    expect(result.chain[0]).toMatchObject({ role: 'span', name: 'We use cookies' });
    expect(result.chain[2]).toMatchObject({
      role: 'dialog',
      name: 'Cookie choices',
      modal: true,
      position: 'fixed',
    });
  });

  it('reads an open dialog element and aria-busy as the structural facts they are', () => {
    const { document, topmost } = page('<button id="go">Go</button><dialog open>Blocking</dialog>');
    topmost(document.querySelector('dialog'));
    const opened = at(document.querySelector('#go')!);
    if (opened.reachable) throw new Error('expected interception');
    expect(opened.chain[0]).toMatchObject({ role: 'dialog', modal: true });

    const busy = page('<button id="b">Go</button><div id="spin" aria-busy="true">Loading</div>');
    busy.topmost(busy.document.querySelector('#spin'));
    const spinning = at(busy.document.querySelector('#b')!);
    if (spinning.reachable) throw new Error('expected interception');
    expect(spinning.chain[0]).toMatchObject({ ariaBusy: true, modal: false });
  });

  it('crosses an open shadow boundary while walking the chain upward', () => {
    const { document, topmost } = page(
      '<button id="go">Go</button><div id="host" role="dialog" aria-label="Shadow modal"></div>',
    );
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="inner">Blocking</span>';
    Object.defineProperty(shadow, 'elementFromPoint', {
      value: () => shadow.querySelector('#inner'),
      configurable: true,
      writable: true,
    });
    topmost(host);
    const result = at(document.querySelector('#go')!);
    if (result.reachable) throw new Error('expected interception');
    expect(result.chain[0]).toMatchObject({ role: 'span', name: 'Blocking' });
    expect(result.chain[1]).toMatchObject({ role: 'dialog', name: 'Shadow modal' });
  });
});
