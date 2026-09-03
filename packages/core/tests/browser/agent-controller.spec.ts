import { access } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';

import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AgentBrowserController,
  type BrowserActionabilityError,
  isNoLayoutBoxError,
  isSameSitePopup,
  StaleElementRefError,
} from '../../src/browser/agent-controller.js';
import { isNavigationRaceError, isUnsettleableRequestUrl } from '../../src/browser/page-settle.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserProvider, BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { classifyFailure } from '../../src/interaction/attempt.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('@no-llm isNavigationRaceError', () => {
  it('classifies document-changed races and rejects other failures', () => {
    expect(
      isNavigationRaceError(
        new Error('Execution context was destroyed, most likely because of a navigation.'),
      ),
    ).toBe(true);
    expect(isNavigationRaceError(new Error('Node is detached from document'))).toBe(true);
    expect(
      isNavigationRaceError(
        new Error('Protocol error (Runtime.callFunctionOn): Cannot find context with specified id'),
      ),
    ).toBe(true);
    expect(isNavigationRaceError(new Error('Attempted to use detached Frame "AB12".'))).toBe(true);
    expect(isNavigationRaceError(new Error('JSHandle is disposed!'))).toBe(true);
    expect(isNavigationRaceError(new Error('net::ERR_NAME_NOT_RESOLVED at https://x'))).toBe(false);
    expect(isNavigationRaceError(new Error('Navigation timeout of 3000 ms exceeded'))).toBe(false);
    expect(isNavigationRaceError('Execution context was destroyed')).toBe(false);
  });
});

describe('@no-llm isNoLayoutBoxError', () => {
  // Pinned to the literal strings puppeteer-core throws from ElementHandle;
  // if a version bump reworders them this test is the early warning.
  it('classifies puppeteer no-box failures and rejects other failures', () => {
    expect(isNoLayoutBoxError(new Error('Node is either not clickable or not an Element'))).toBe(
      true,
    );
    expect(isNoLayoutBoxError(new Error('Node is either not visible or not an HTMLElement'))).toBe(
      true,
    );
    expect(isNoLayoutBoxError(new Error('Execution context was destroyed'))).toBe(false);
    expect(isNoLayoutBoxError(new Error('Navigation timeout of 3000 ms exceeded'))).toBe(false);
    expect(isNoLayoutBoxError('Node is either not clickable or not an Element')).toBe(false);
  });
});

describe('@no-llm isSameSitePopup', () => {
  it('accepts a site continuing into its own tab and refuses anyone else', () => {
    // The shapes from the runs this rule exists for.
    expect(
      isSameSitePopup('https://www.kayak.com/stays', 'https://www.kayak.com/hotels/Frisco;map'),
    ).toBe(true);
    expect(
      isSameSitePopup('https://www.priceline.com/hotels/', 'https://www.priceline.com/relax-ui/'),
    ).toBe(true);
    expect(isSameSitePopup('https://google.com/travel', 'https://accounts.google.com/x')).toBe(
      true,
    );
    expect(isSameSitePopup('https://accounts.google.com/x', 'https://google.com/travel')).toBe(
      true,
    );
    expect(isSameSitePopup('https://WWW.Kayak.com/a', 'http://kayak.com/b')).toBe(true);

    // The monetization redirect that made following the URL worse than useless.
    expect(isSameSitePopup('https://www.kayak.com/stays', 'https://www.booking.com/x')).toBe(false);
    expect(isSameSitePopup('https://www.kayak.com/stays', 'https://www.vrbo.com/search')).toBe(
      false,
    );
    // A shared public suffix is not a shared site — the trap a "last two
    // labels" rule falls into.
    expect(isSameSitePopup('https://bbc.co.uk/news', 'https://evil.co.uk/news')).toBe(false);
    // Lookalikes that merely end with the same text are not subdomains.
    expect(isSameSitePopup('https://kayak.com/a', 'https://notkayak.com/b')).toBe(false);

    // Nowhere to continue a run.
    expect(isSameSitePopup('https://kayak.com/a', 'about:blank')).toBe(false);
    expect(isSameSitePopup('https://kayak.com/a', 'blob:https://kayak.com/abc')).toBe(false);
    expect(isSameSitePopup('https://kayak.com/a', 'javascript:void(0)')).toBe(false);
    expect(isSameSitePopup('', 'https://kayak.com/a')).toBe(false);
  });
});

describe('@no-llm isUnsettleableRequestUrl', () => {
  // These schemes are why the network-quiet wait cannot read a raw in-flight
  // count: the page hears the request start and never hears it end, so one of
  // them makes strict idle unreachable for the life of the document.
  it('classifies renderer-served URLs and rejects network ones', () => {
    expect(
      isUnsettleableRequestUrl('blob:https://www.ups.com/6cdf9851-830c-4ce4-a3ad-4e10f34'),
    ).toBe(true);
    expect(isUnsettleableRequestUrl('data:text/javascript,console.log(1)')).toBe(true);
    expect(isUnsettleableRequestUrl('filesystem:https://example.com/temporary/worker.js')).toBe(
      true,
    );
    expect(isUnsettleableRequestUrl('BLOB:https://example.com/abc')).toBe(true);
    expect(isUnsettleableRequestUrl('https://example.com/app.js')).toBe(false);
    expect(isUnsettleableRequestUrl('http://127.0.0.1:8080/api')).toBe(false);
    expect(isUnsettleableRequestUrl('about:blank')).toBe(false);
    // Only the scheme counts — a network URL that merely mentions one does not.
    expect(isUnsettleableRequestUrl('https://example.com/blob:worker')).toBe(false);
    expect(isUnsettleableRequestUrl('')).toBe(false);
  });
});

describe('@no-llm AgentBrowserController', () => {
  let server: Server;
  let baseUrl: string;
  /** Deliberately unanswered responses; released in afterAll so close() can. */
  const hangingResponses: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/popup-target') {
        response.end('<title>Popup</title><p>popup target</p><button>Continue in tab</button>');
        return;
      }
      if (path === '/cross-popup') {
        // `localhost` and `127.0.0.1` are the same server and different sites,
        // which is exactly the distinction popup handling turns on — without
        // needing a second listener or a real third-party host.
        const elsewhere = `http://${(request.headers.host ?? '').replace('127.0.0.1', 'localhost')}/popup-target`;
        response.end(`<!doctype html><title>Cross popup</title>
          <a href="${elsewhere}" target="_blank">Open elsewhere</a>`);
        return;
      }
      if (path === '/bounce-opener') {
        // KAYAK's shape: the results open in a new tab and the tab you are
        // standing on is sent to a partner in the same gesture.
        const partner = `http://${(request.headers.host ?? '').replace('127.0.0.1', 'localhost')}/next`;
        response.end(`<!doctype html><title>Bounce opener</title>
          <button onclick="window.open('/popup-target'); location.href='${partner}'">Search</button>`);
        return;
      }
      if (path === '/obstructed') {
        // Generic pattern: a page-blocking modal over the control the caller
        // asked for, offering an unambiguous dismissal beside an acceptance the
        // engine must never press.
        response.end(`<!doctype html><title>Obstructed</title>
          <style>
            #scrim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9}
            #consent{position:fixed;left:0;top:0;right:0;bottom:0;z-index:10;background:#fff}
            #sticky{position:sticky;top:0;height:120px;background:#eee}
            .busy{position:fixed;inset:0;z-index:11;background:#fff}
          </style>
          <button id="under" onclick="document.title='Under pressed'">Under the modal</button>
          <div id="scrim"><div id="consent" role="dialog" aria-modal="true" aria-label="Cookie choices">
            <p>We use cookies</p>
            <button id="accept">Accept all</button>
            <button id="close" onclick="document.querySelector('#scrim').remove()">Close</button>
            <a href="/next">Close and read our policy</a>
          </div></div>`);
        return;
      }
      if (path === '/obstructed-accept-only') {
        response.end(`<!doctype html><title>Accept only</title>
          <style>#c{position:fixed;inset:0;z-index:10;background:#fff}</style>
          <button id="under" onclick="document.title='Under pressed'">Under the modal</button>
          <div id="c" role="dialog" aria-modal="true" aria-label="Consent required">
            <button id="accept">Accept all</button>
            <button id="guarded">Confirm and close</button>
          </div>`);
        return;
      }
      if (path === '/obstructed-busy') {
        response.end(`<!doctype html><title>Busy</title>
          <style>#b{position:fixed;inset:0;z-index:10;background:#fff}</style>
          <button id="under">Under the spinner</button>
          <div id="b" aria-busy="true" role="progressbar" aria-label="Loading results">Loading</div>`);
        return;
      }
      if (path === '/obstructed-rerender') {
        // The modal re-raises itself when dismissed: the bound must hold and the
        // second report must be terminal rather than buying another press.
        response.end(`<!doctype html><title>Rerender</title>
          <style>.c{position:fixed;inset:0;z-index:10;background:#fff}</style>
          <button id="under" onclick="document.title='Under pressed'">Under the modal</button>
          <div id="wrap"><div class="c" role="dialog" aria-modal="true" aria-label="Stay a while">
            <button onclick="raise()">Close</button></div></div>
          <script>
            function raise() {
              const wrap = document.querySelector('#wrap');
              wrap.innerHTML = '<div class="c" role="dialog" aria-modal="true" aria-label="Stay a while"><button onclick="raise()">Close</button></div>';
            }
          </script>`);
        return;
      }
      if (path === '/obstructed-sticky') {
        // Generic pattern: a control whose clickable point falls under a
        // viewport-pinned band once the page scrolls it into view.
        response.end(`<!doctype html><title>Sticky</title>
          <style>
            body{margin:0}
            #band{position:fixed;left:0;top:0;right:0;height:100vh;background:#ddd;z-index:5}
          </style>
          <div id="band">Site header</div>
          <div style="height:2400px"></div>
          <button id="under" onclick="document.title='Under pressed'">Under the band</button>`);
        return;
      }
      if (path === '/obstructed-field') {
        response.end(`<!doctype html><title>Obstructed field</title>
          <style>#c{position:fixed;inset:0;z-index:10;background:#fff}</style>
          <input id="text" aria-label="Covered field">
          <select id="pick" aria-label="Covered select"><option>Alpha</option><option>Beta</option></select>
          <div id="c" role="dialog" aria-modal="true" aria-label="Interstitial"><p>Blocking</p></div>`);
        return;
      }
      if (path === '/obstructed-two-fields') {
        response.end(`<!doctype html><title>Two fields</title>
          <style>.c{position:fixed;inset:0;z-index:10;background:#fff}</style>
          <input id="a" aria-label="First field">
          <input id="b" aria-label="Second field">
          <div id="wrap"><div class="c" role="dialog" aria-modal="true" aria-label="Interstitial">
            <button onclick="raise()">Close</button></div></div>
          <script>
            function raise() {
              document.querySelector('#wrap').innerHTML =
                '<div class="c" role="dialog" aria-modal="true" aria-label="Interstitial">' +
                '<button onclick="raise()">Close</button></div>';
            }
          </script>`);
        return;
      }
      if (path === '/clipped') {
        // A first content quad whose centre lies outside the viewport, and an
        // element taller than the viewport: the cases a centre-point test
        // cannot satisfy but `clickablePoint()` can.
        response.end(`<!doctype html><title>Clipped</title>
          <style>body{margin:0}</style>
          <button id="tall" style="height:2400px;width:200px"
            onclick="document.title='Tall pressed'">Very tall control</button>
          <div style="height:1200px"></div>
          <button id="wide" style="width:6000px"
            onclick="document.title='Wide pressed'">Very wide control</button>`);
        return;
      }
      if (path === '/late-overlay') {
        // Layout changes between pre-flight and dispatch: a mousemove listener
        // raises the overlay after hover, so the existing stale/hidden recovery
        // owns the race rather than a new mechanism.
        response.end(`<!doctype html><title>Late overlay</title>
          <button id="under" onclick="document.title='Under pressed'">Target</button>
          <script>
            document.addEventListener('mousemove', () => {
              if (document.querySelector('#late')) return;
              const late = document.createElement('div');
              late.id = 'late';
              late.setAttribute('role', 'dialog');
              late.setAttribute('aria-modal', 'true');
              late.setAttribute('aria-label', 'Arrived late');
              late.style.cssText = 'position:fixed;inset:0;z-index:10;background:#fff';
              document.body.append(late);
            }, { once: true });
          </script>`);
        return;
      }
      if (path === '/tall') {
        response.end(`<!doctype html><title>Tall</title>
          <div style="height:3000px"></div>
          <button onclick="document.title='Tall';document.body.append(' clicked below fold')">Below fold</button>
          <input aria-label="Below fold field">`);
        return;
      }
      if (path === '/next') {
        response.end('<title>Next</title><button>Arrived</button>');
        return;
      }
      if (path === '/composed-shadow') {
        // Generic pattern: a page that encapsulates controls inside components'
        // own shadow trees, interleaved with ordinary light-DOM controls. The
        // interleaving is what makes this a regression test rather than a smoke
        // test — a flat-tree handle query cannot see the shadow-hosted
        // elements, so every index after the first host names a different
        // element than the record it was paired with.
        response.end(`<!doctype html><title>Composed</title>
          <button>Light one</button>
          <div id="open-host"></div>
          <button>Light two</button>
          <div id="closed-host"></div>
          <button>Light three</button>
          <div id="detachable-host"></div>
          <script>
            const mount = (id, mode, label) => {
              const root = document.getElementById(id).attachShadow({ mode });
              const button = document.createElement('button');
              button.textContent = label;
              root.appendChild(button);
              return root;
            };
            mount('open-host', 'open', 'Shadow open');
            mount('closed-host', 'closed', 'Shadow closed');
            window.__detachable = mount('detachable-host', 'open', 'Shadow detachable');
          </script>`);
        return;
      }
      if (path === '/many') {
        // 50 interactables, more than the 30 model-visible cap, plus an open
        // autocomplete listbox whose options only a scan that selects
        // [role="option"] can see.
        const buttons = Array.from(
          { length: 50 },
          (_, i) => `<button>Action ${String(i).padStart(2, '0')}</button>`,
        ).join('');
        const options = ['Chicago, IL', 'Chicago Midway', 'Chicopee, MA']
          .map((name) => `<li role="option">${name}</li>`)
          .join('');
        response.end(`<!doctype html><title>Many</title>
          <input aria-label="Destination" role="combobox">
          <ul role="listbox">${options}</ul>
          ${buttons}`);
        return;
      }
      if (path === '/delayed') {
        // The reported real-world failure shape: the site starts its
        // navigation on a timer well after the click handler returns.
        response.end(`<!doctype html><title>Delayed</title>
          <button onclick="setTimeout(() => { location.href = '/next'; }, 150)">Go later</button>`);
        return;
      }
      if (path === '/chain') {
        response.end('<!doctype html><title>Chain</title><a href="/hop">Begin chain</a>');
        return;
      }
      if (path === '/hop') {
        response.end(`<!doctype html><title>Hop</title>
          <script>setTimeout(() => location.replace('/next'), 100)</script><p>hopping</p>`);
        return;
      }
      if (path === '/dialog') {
        response.end(`<!doctype html><title>Dialog</title>
          <button onclick="alert('Heads up'); document.title='Alerted'">Alert me</button>
          <button onclick="document.title = confirm('Proceed?') ? 'Accepted' : 'Declined'">Confirm me</button>`);
        return;
      }
      if (path === '/dynamic-popup') {
        response.end(`<!doctype html><title>Dynamic popup</title>
          <button id="opener">Open dynamic</button>
          <script>document.getElementById('opener')
            .addEventListener('click', () => window.open('/popup-target'));</script>`);
        return;
      }
      if (path === '/history-nav') {
        // The single-page shape behind the real failure: choosing a control
        // pushes a new URL *and* re-mounts the control, so the commit event
        // fires while every element is still live and the old ref still names
        // something real.
        response.end(`<!doctype html><title>History nav</title>
          <button id="pick" aria-label="Check-in">Check-in</button>
          <script>document.getElementById('pick').addEventListener('click', () => {
            history.pushState({}, '', '/history-nav?picked=1');
            const previous = document.getElementById('pick');
            previous.replaceWith(previous.cloneNode(true));
          });</script>`);
        return;
      }
      if (path === '/overlay-calendar') {
        // The shape behind the reported failure: the site serves its date
        // picker already open, and its markup precedes the form. The day cells
        // therefore fill the model-visible cap and the search form the agent
        // came for is structurally invisible.
        const days = Array.from(
          { length: 60 },
          (_, index) => `<button>August ${index + 1}, 2026</button>`,
        ).join('');
        response.end(`<!doctype html><title>Overlay calendar</title>
          <div id="picker" role="dialog"
               style="position:absolute;left:0;top:0;width:300px;height:200px">${days}</div>
          <form><input aria-label="Destination"><button>Search</button></form>
          <script>document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') document.getElementById('picker').style.display = 'none';
          });</script>`);
        return;
      }
      if (path === '/overlay-static-grid') {
        // Results marked up as a grid are page content, not a popover. The
        // title records whether anything pressed Escape at all.
        response.end(`<!doctype html><title>Static grid</title>
          <div role="grid"><div role="gridcell"><button>Row action</button></div></div>
          <input aria-label="Filter">
          <script>document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') document.title = 'Escaped';
          });</script>`);
        return;
      }
      if (path === '/overlay-stubborn') {
        // A consent wall that ignores Escape: the pass must cost one keypress
        // and then report the overlay rather than keep hammering it.
        response.end(`<!doctype html><title>Stubborn</title>
          <div role="dialog" aria-modal="true"
               style="position:fixed;left:0;top:0;width:400px;height:300px">
            <button>Accept all</button>
          </div>
          <script>let presses = 0;
          document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { presses += 1; document.title = 'Escaped ' + presses; }
          });</script>`);
        return;
      }
      if (path === '/click-dialog') {
        response.end(`<!doctype html><title>Click dialog</title>
          <button id="open">Change dates</button>
          <div id="panel" role="dialog"
               style="position:absolute;left:0;top:0;width:200px;height:100px;display:none">
            <button>Apply</button>
          </div>
          <script>document.getElementById('open').addEventListener('click', () => {
            document.getElementById('panel').style.display = 'block';
          });
          document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') document.getElementById('panel').style.display = 'none';
          });</script>`);
        return;
      }
      if (path === '/spa') {
        response.end(`<!doctype html><title>Spa</title>
          <button id="load">Load data</button><p id="out">empty</p>
          <script>document.getElementById('load').addEventListener('click', async () => {
            const res = await fetch('/slow-fragment');
            document.getElementById('out').textContent = await res.text();
          });</script>`);
        return;
      }
      if (path === '/slow-fragment') {
        // Slower than the post-click navigation grace window so only the
        // network-quiet wait can cover it.
        setTimeout(() => response.end('fragment loaded'), 1_500);
        return;
      }
      if (path === '/spa-verylate') {
        // Same shape as /spa, but the fetch is slower than the OLD 3s
        // network-quiet cap (regression: a carrier tracking page that
        // populates its result 5-30s after the initial click/load).
        response.end(`<!doctype html><title>Spa verylate</title>
          <button id="load">Load data</button><p id="out">empty</p>
          <script>document.getElementById('load').addEventListener('click', async () => {
            const res = await fetch('/slow-fragment-verylate');
            document.getElementById('out').textContent = await res.text();
          });</script>`);
        return;
      }
      if (path === '/slow-fragment-verylate') {
        setTimeout(() => response.end('very late fragment loaded'), 6_000);
        return;
      }
      if (path === '/hanging-fetch') {
        response.end(`<!doctype html><title>Hanging fetch</title><button>Ready</button>
          <script>fetch('/never-responds').catch(() => {});</script>`);
        return;
      }
      if (path === '/never-responds') {
        // Headers never sent, so no response/failure/finish event ever fires.
        hangingResponses.push(response);
        return;
      }
      if (path === '/refuses-stamp') {
        // A page that will not accept the document marker. The epoch must
        // degrade to null without throwing, and a delta across two unstamped
        // frames must claim no replacement either way.
        response.end(`<!doctype html><title>Refuses stamp</title>
          <button>Ready</button>
          <script>Object.defineProperty(window, '__yantraDocument', {
            configurable: false,
            get() { throw new Error('refused'); },
            set() { throw new Error('refused'); },
          });</script>`);
        return;
      }
      if (path === '/delta-dialog') {
        // Generic consent shape: a labelled modal opens on click and closes on
        // its own control. Nothing here keys off a site — role, accessible
        // name, and visibility are the whole signal.
        response.end(`<!doctype html><title>Delta dialog</title>
          <style>#panel{position:fixed;inset:0;z-index:10;background:#fff;display:none}</style>
          <button id="open">Open preferences</button>
          <div id="panel" role="dialog" aria-modal="true" aria-label="Cookie consent">
            <button id="close">Close</button>
          </div>
          <script>
            const panel = document.getElementById('panel');
            document.getElementById('open').addEventListener('click', () => {
              panel.style.display = 'block';
            });
            document.getElementById('close').addEventListener('click', () => {
              panel.style.display = 'none';
            });
          </script>`);
        return;
      }
      if (path === '/delta-remount') {
        // A results panel that replaces its entire control set with an
        // identical one. Every ref trades hands; semantically nothing changed.
        response.end(`<!doctype html><title>Delta remount</title>
          <button id="refresh">Refresh results</button>
          <div id="results">
            <button>Result one</button><button>Result two</button><button>Result three</button>
          </div>
          <script>
            document.getElementById('refresh').addEventListener('click', () => {
              const results = document.getElementById('results');
              results.innerHTML = results.innerHTML;
            });
          </script>`);
        return;
      }
      if (path === '/delta-reorder') {
        // Same-named controls that swap document order on click. Refs are
        // minted by (role, name, ordinal), so these demonstrably trade
        // identities — and the delta must still report nothing.
        response.end(`<!doctype html><title>Delta reorder</title>
          <button id="shuffle">Shuffle</button>
          <div id="rows">
            <div><span>Row A</span><button>Select</button></div>
            <div><span>Row B</span><button>Select</button></div>
            <div><span>Row C</span><button>Select</button></div>
          </div>
          <script>
            document.getElementById('shuffle').addEventListener('click', () => {
              const rows = document.getElementById('rows');
              rows.prepend(rows.lastElementChild);
            });
          </script>`);
        return;
      }
      if (path === '/delta-over-cap') {
        // More visible interactables than the model-visible cap, with the
        // acted-on control beyond it: the fingerprint sees the whole page, so
        // nothing the observation had to drop may be reported as vanished.
        const filler = Array.from(
          { length: 80 },
          (_, index) => `<button>Filler ${String(index).padStart(2, '0')}</button>`,
        ).join('');
        response.end(`<!doctype html><title>Delta over cap</title>
          ${filler}
          <button id="last" onclick="document.title='Last pressed'">Beyond the cap</button>`);
        return;
      }
      if (path === '/delta-focus') {
        response.end(`<!doctype html><title>Delta focus</title>
          <input id="origin" aria-label="Origin">
          <button id="take">Take focus</button>
          <script>
            document.getElementById('origin').focus();
            document.getElementById('take').addEventListener('click', function () {
              this.focus();
            });
          </script>`);
        return;
      }
      if (path === '/select-form') {
        response.end(`<!doctype html><title>Select</title>
          <select aria-label="Country" onchange="document.title='picked:'+this.value">
            <option value="">Choose</option>
            <option value="us">United States</option>
            <option value="de">Germany</option>
          </select>`);
        return;
      }
      const many = Array.from({ length: 45 }, (_, index) => `<button>Item ${index}</button>`).join(
        '',
      );
      response.end(`<!doctype html><title>Controller fixture</title>
        <style>#overlay{position:fixed;left:0;top:0;width:180px;height:50px;z-index:2}</style>
        <div style="margin-top:70px">
          <a href="/next">Next page</a>
          <a href="/popup-target" target="_blank">Open target</a>
          <button onclick="window.open('/popup-target')">Open window</button>
          <button onclick="document.querySelector('#state').textContent='changed'">Mutate</button>
          <button onclick="this.remove()">Vanish</button>
          <button disabled>Disabled action</button>
          <button aria-disabled="true">Aria disabled action</button>
          <button onclick="document.querySelector('#hideable').style.visibility='hidden'">Hide it</button>
          <input id="hideable" aria-label="Hideable field">
          <form action="/next">
            <input aria-label="Username" name="u">
            <input aria-label="Password" name="p" type="password">
            <button type="submit">Sign in</button>
          </form>
        </div>
        <button id="covered" style="position:absolute;left:10px;top:10px">Covered action</button>
        <div id="overlay">overlay</div>
        <p id="state">initial</p>
        <p>admin@example.com sk-ABCDEF0123456789abcdef01 ${'x'.repeat(40_000)}</p>
        <div style="margin-top:80px">${many}</div>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const response of hangingResponses) response.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('launches lazily with an ephemeral profile and tears down idempotently', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'lazy-run',
      browserProvider: tracked.provider,
      logger,
    });
    expect(controller.launched).toBe(false);
    expect(tracked.launch).not.toHaveBeenCalled();

    await controller.navigate(`${baseUrl}/`);
    const profileDir = controller.profileDir!;
    await expect(access(profileDir)).resolves.toBeUndefined();
    expect(tracked.launch).toHaveBeenCalledOnce();
    const runtimeIdentity = await tracked.page!.puppeteerPage!.evaluate(() => ({
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      language: navigator.language,
    }));
    expect(runtimeIdentity.userAgent).toContain('Chrome/');
    expect(runtimeIdentity.userAgent).not.toContain('HeadlessChrome');
    expect(runtimeIdentity.webdriver).toBe(false);
    expect(runtimeIdentity.language).toMatch(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i);

    await controller.teardown();
    await controller.teardown();
    await expect(access(profileDir)).rejects.toThrow();
  }, 45_000);

  it('intercepts popups from one observation without staling sibling refs', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'popup-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);

    // Both clicks use the same observation: intercepting the first popup must
    // leave the second element's ref usable without re-observing.
    const observation = await controller.observe();
    const target = observation.interactables.find((entry) => entry.name === 'Open target')!;
    const windowButton = observation.interactables.find((entry) => entry.name === 'Open window')!;
    const targetResult = await controller.click(target.ref);
    expect(targetResult.popup_intercepted).toBe(`${baseUrl}/popup-target`);

    const windowResult = await controller.click(windowButton.ref);
    expect(windowResult.popup_intercepted).toBe(`${baseUrl}/popup-target`);
    // The second click discarded the first click's unadopted tab, so a run that
    // never follows one still accumulates at most a single spare page.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(2);
    await controller.teardown();
  }, 45_000);

  it('offers a same-site popup for adoption and closes it if nobody adopts', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'popup-offer-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const target = observation.interactables.find((entry) => entry.name === 'Open target')!;

    const opened = await controller.click(target.ref);
    expect(opened.popup_followable).toBe(`${baseUrl}/popup-target`);
    expect(controller.followablePopupUrl()).toBe(`${baseUrl}/popup-target`);

    // Declining is the default: the next navigation closes the held tab and the
    // run is still on the page it was on.
    await controller.navigate(`${baseUrl}/next`);
    expect(controller.followablePopupUrl()).toBeNull();
    expect(controller.url()).toBe(`${baseUrl}/next`);
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(1);
    await controller.teardown();
  }, 45_000);

  it('adopts a same-site popup as the run page, retiring the tab that opened it', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'popup-adopt-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const target = observation.interactables.find((entry) => entry.name === 'Open target')!;
    await controller.click(target.ref);

    const adopted = await controller.adoptPopup();
    expect(adopted?.switched_to_new_tab).toBe(`${baseUrl}/popup-target`);
    expect(adopted?.title).toBe('Popup');
    expect(controller.url()).toBe(`${baseUrl}/popup-target`);
    // The opener is gone, so the run holds one page — the adopted one.
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(1);

    // Adoption replaces the document, so refs minted on the opener are dead and
    // the adopted page is observable in its own right.
    await expect(controller.click(target.ref)).rejects.toBeInstanceOf(StaleElementRefError);
    const after = await controller.observe();
    expect(after.interactables.map((entry) => entry.name)).toContain('Continue in tab');

    // Nothing is left to adopt twice.
    expect(await controller.adoptPopup()).toBeNull();
    await controller.teardown();
  }, 45_000);

  it('still adopts the results tab when the site bounces the opener elsewhere', async () => {
    // The failure this whole path exists for: following the returned address
    // would have loaded the partner site, because the tab doing the loading is
    // the one that was bounced. Adoption must key on where the popup came from,
    // not on where its opener has since ended up.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'popup-bounce-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/bounce-opener`);
    const observation = await controller.observe();
    const search = observation.interactables.find((entry) => entry.name === 'Search')!;

    const clicked = await controller.click(search.ref);
    expect(clicked.url).toContain('localhost');
    expect(clicked.popup_followable).toBe(`${baseUrl}/popup-target`);

    const adopted = await controller.adoptPopup();
    expect(adopted?.switched_to_new_tab).toBe(`${baseUrl}/popup-target`);
    expect(controller.url()).toBe(`${baseUrl}/popup-target`);
    await controller.teardown();
  }, 45_000);

  it('closes a cross-site popup on sight and never offers it for adoption', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'popup-cross-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/cross-popup`);
    const observation = await controller.observe();
    const link = observation.interactables.find((entry) => entry.name === 'Open elsewhere')!;

    const result = await controller.click(link.ref);
    expect(result.popup_intercepted).toContain('localhost');
    expect(result.popup_followable).toBeUndefined();
    expect(controller.followablePopupUrl()).toBeNull();
    expect(await controller.adoptPopup()).toBeNull();
    expect(controller.url()).toBe(`${baseUrl}/cross-popup`);
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(1);
    await controller.teardown();
  }, 45_000);

  it('closes a picker the site served open, restoring the form to the observation', async () => {
    // Regression for runs 20260811T023421Z-do-83684cb3 and
    // 20260811T025845Z-do-963e62f1: every landing returned 50 interactables of
    // which 50 were day cells, so `browser_fill_element` could not find
    // "Destination" and answered with a list of dates instead.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'overlay-run',
      browserProvider: tracked.provider,
      logger,
    });

    const result = await controller.navigate(`${baseUrl}/overlay-calendar`);

    expect(result.overlays_dismissed).toBe(1);
    const names = (await controller.observe()).interactables.map((entry) => entry.name);
    expect(names).toContain('Destination');
    expect(names).toContain('Search');
    expect(names.filter((name) => name.startsWith('August'))).toHaveLength(0);
    await controller.teardown();
  }, 45_000);

  it('leaves statically positioned page content alone, without pressing Escape', async () => {
    // A results table marked up as role="grid" is content. Escaping it on every
    // load would be a keystroke into a page that is showing what it should.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'overlay-content-run',
      browserProvider: tracked.provider,
      logger,
    });

    const result = await controller.navigate(`${baseUrl}/overlay-static-grid`);

    expect(result.overlays_dismissed).toBeUndefined();
    expect(result.title).toBe('Static grid');
    expect((await controller.observe()).interactables.map((entry) => entry.name)).toContain(
      'Row action',
    );
    await controller.teardown();
  }, 45_000);

  it('gives up on an overlay that ignores Escape after a single press', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'overlay-stubborn-run',
      browserProvider: tracked.provider,
      logger,
    });

    const result = await controller.navigate(`${baseUrl}/overlay-stubborn`);

    expect(result.overlays_dismissed).toBeUndefined();
    // One press, not three: an Escape that closed nothing will not close
    // anything on a second try, and the navigation still succeeds.
    expect(result.title).toBe('Escaped 1');
    expect((await controller.observe()).interactables.map((entry) => entry.name)).toContain(
      'Accept all',
    );
    await controller.teardown();
  }, 45_000);

  it('keeps a dialog the agent opened by clicking', async () => {
    // Ownership is the whole safety property: the site's overlays are closed,
    // the agent's own are not — it may have opened this one to operate it.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'overlay-owned-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/click-dialog`);
    const opener = (await controller.observe()).interactables.find(
      (entry) => entry.name === 'Change dates',
    )!;

    const result = await controller.click(opener.ref);

    expect(result.overlays_dismissed).toBeUndefined();
    expect((await controller.observe()).interactables.map((entry) => entry.name)).toContain(
      'Apply',
    );
    await controller.teardown();
  }, 45_000);

  it('caps the model-visible observation at 50 but resolves more under an explicit cap', async () => {
    // `browser_form_fill` needs to address elements outside the model-visible
    // cap; `browser_observe` must not be widened by that. The cap argument is
    // for internal resolution only.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'cap-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/many`);

    const modelVisible = await controller.observe();
    const internal = await controller.observe({ cap: 400, trackDigest: false });

    expect(modelVisible.interactables).toHaveLength(50);
    expect(internal.interactables.length).toBeGreaterThan(50);
    // The cap is clamped, so an absurd request cannot explode the handle set.
    const clamped = await controller.observe({ cap: 10_000, trackDigest: false });
    expect(clamped.interactables.length).toBeLessThanOrEqual(400);
    await controller.teardown();
  }, 45_000);

  it('exposes open autocomplete options to an uncapped observation', async () => {
    // Regression: `[role="option"]` was absent from the scan selector, so the
    // real suggestions of a destination combobox were structurally invisible
    // and the agent clicked a marketing tile instead.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'option-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/many`);

    const observation = await controller.observe({ cap: 400 });
    const options = observation.interactables.filter((entry) => entry.role === 'option');

    expect(options.map((entry) => entry.name)).toEqual([
      'Chicago, IL',
      'Chicago Midway',
      'Chicopee, MA',
    ]);
    // Refs still resolve to live elements, so the option can actually be clicked.
    expect(() => controller.resolveRef(options[0]!.ref)).not.toThrow();
    await controller.teardown();
  }, 45_000);

  it('keeps ref ids stable and refs live until the document actually changes', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'refs-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const first = await controller.observe();
    const mutateRef = first.interactables.find((entry) => entry.name === 'Mutate')!.ref;

    // Re-observing the same document refreshes handles but keeps the ids.
    const second = await controller.observe();
    expect(second.interactables).toEqual(first.interactables);
    expect(() => controller.resolveRef(mutateRef)).not.toThrow();

    // A successful DOM action no longer invalidates the acted-on ref or its
    // siblings (regression: fill(e1) used to make fill(e2) report stale).
    await controller.click(mutateRef);
    expect(() => controller.resolveRef(mutateRef)).not.toThrow();
    const third = await controller.observe();
    expect(third.interactables).toEqual(first.interactables);

    // A reload replaces the document, so refs from before it are stale.
    const beforeReload = (await controller.observe()).interactables[0]!.ref;
    await tracked.page!.puppeteerPage!.reload({ waitUntil: 'load' });
    expect(() => controller.resolveRef(beforeReload)).toThrow(StaleElementRefError);

    const beforeNavigation = (await controller.observe()).interactables[0]!.ref;
    await controller.navigate(`${baseUrl}/next`);
    expect(() => controller.resolveRef(beforeNavigation)).toThrow(StaleElementRefError);
    expect(() => controller.resolveRef('e-never')).toThrow(StaleElementRefError);
    await controller.teardown();
  }, 45_000);

  it('fills sibling fields and submits a form from a single observation', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'login-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const username = observation.interactables.find((entry) => entry.name === 'Username')!;
    const password = observation.interactables.find((entry) => entry.name === 'Password')!;
    const submit = observation.interactables.find((entry) => entry.name === 'Sign in')!;

    await controller.fill(username.ref, 'tomsmith');
    // Regression: this second fill used to throw STALE_ELEMENT_REF because the
    // first fill invalidated every ref from the observation.
    await controller.fill(password.ref, 'swordfish');
    // Regression: this click used to race the form-submit navigation and
    // surface as an unexpected tool failure even though the click landed. It
    // must return the destination page.
    const result = await controller.click(submit.ref);
    expect(result.url).toContain('/next');
    expect(result.url).toContain('u=tomsmith');
    expect(result.url).toContain('p=swordfish');
    expect(result.title).toBe('Next');
    await controller.teardown();
  }, 45_000);

  // Regression for the reported real-world failure: the click returned the
  // old page because the site started its navigation ~150ms later, and the
  // agent's next tool call then raced (and lost to) the navigation.
  it('waits for a navigation the site starts well after the click', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'delayed-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/delayed`);
    const observation = await controller.observe();
    const button = observation.interactables.find((entry) => entry.name === 'Go later')!;
    const result = await controller.click(button.ref);
    expect(result.url).toContain('/next');
    expect(result.title).toBe('Next');
    await controller.teardown();
  }, 45_000);

  it('follows client-side redirect chains before reporting the result', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'chain-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/chain`);
    const observation = await controller.observe();
    const link = observation.interactables.find((entry) => entry.name === 'Begin chain')!;
    // /chain -> /hop commits first; /hop then JS-redirects to /next. The
    // click must report the document that will stay, not the hop.
    const result = await controller.click(link.ref);
    expect(result.url).toContain('/next');
    expect(result.title).toBe('Next');
    await controller.teardown();
  }, 45_000);

  it('auto-dismisses JS dialogs and surfaces them on the action result', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'dialog-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/dialog`);
    const observation = await controller.observe();
    const alertButton = observation.interactables.find((entry) => entry.name === 'Alert me')!;
    const confirmButton = observation.interactables.find((entry) => entry.name === 'Confirm me')!;
    // An unhandled alert() freezes every evaluate on the page; the click must
    // resolve, report the dialog, and leave the page responsive.
    const alerted = await controller.click(alertButton.ref);
    expect(alerted.dialog_intercepted).toBe('alert: Heads up');
    expect(alerted.title).toBe('Alerted');
    // confirm() is dismissed (never silently accepted): the handler sees false.
    const confirmed = await controller.click(confirmButton.ref);
    expect(confirmed.dialog_intercepted).toBe('confirm: Proceed?');
    expect(confirmed.title).toBe('Declined');
    await controller.teardown();
  }, 45_000);

  it('intercepts popups opened by dynamic event listeners, not just declared ones', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'dynamic-popup-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/dynamic-popup`);
    const observation = await controller.observe();
    const opener = observation.interactables.find((entry) => entry.name === 'Open dynamic')!;
    // No target=_blank and no inline onclick: only the background capture can
    // attribute this popup, and the click result must still carry it.
    const result = await controller.click(opener.ref);
    expect(result.popup_intercepted).toBe(`${baseUrl}/popup-target`);
    expect(result.popup_followable).toBe(`${baseUrl}/popup-target`);
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(2);
    await controller.teardown();
  }, 45_000);

  it('reports only after fetch-driven DOM updates have landed', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'spa-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/spa`);
    const observation = await controller.observe();
    const load = observation.interactables.find((entry) => entry.name === 'Load data')!;
    // The fetch takes longer than the navigation grace window; only the
    // network-quiet wait keeps the very next extract from seeing stale DOM.
    await controller.click(load.ref);
    expect(await controller.extract('content')).toMatchObject({
      text: expect.stringContaining('fragment loaded') as string,
    });
    await controller.teardown();
  }, 45_000);

  // Regression for the reported real-world failure: a carrier tracking page
  // whose result populates 10-30s after the click was read as empty/loading
  // because the network-quiet wait was capped at 3s regardless of the larger
  // overall settle budget. The fetch here (6s) is well past that old cap but
  // comfortably inside the current ~60s settle budgets.
  it('waits out a slow (multi-second) fetch-driven update before reporting content', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'spa-verylate-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/spa-verylate`);
    const observation = await controller.observe();
    const load = observation.interactables.find((entry) => entry.name === 'Load data')!;
    await controller.click(load.ref);
    expect(await controller.extract('content')).toMatchObject({
      text: expect.stringContaining('very late fragment loaded') as string,
    });
    await controller.teardown();
  }, 45_000);

  // Regression for the ~60s floor every browser tool call paid. A request that
  // never reports completion (here a hung endpoint; in the field, the
  // blob-backed workers on ups.com) pinned the in-flight count above zero for
  // the life of the document, so strict network idle was unreachable and every
  // call ran to the ~60s cap. Measured on ups.com before the fix: navigate
  // 61.6s, observe 60.4s, extract 60.0s.
  //
  // The bounds are far above the real cost and far below the cap, so they fail
  // decisively either way, and the test timeout leaves the broken path room to
  // finish and report its number rather than time out opaquely.
  it('stops waiting on a request that never responds, and does not re-pay it', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'hanging-fetch-run',
      browserProvider: tracked.provider,
      logger,
    });

    // The hung request is younger than the stale window here, so this first
    // call still waits it out — bounded by that window, not by the cap.
    const navigateStart = Date.now();
    await controller.navigate(`${baseUrl}/hanging-fetch`);
    expect(Date.now() - navigateStart).toBeLessThan(30_000);

    // By now it has aged out, so it costs the run nothing further: this is the
    // part that made every subsequent tool call in a session pay 60s.
    const observeStart = Date.now();
    const observation = await controller.observe();
    expect(Date.now() - observeStart).toBeLessThan(10_000);
    expect(observation.interactables.map((entry) => entry.name)).toContain('Ready');

    const extractStart = Date.now();
    await controller.extract('content');
    expect(Date.now() - extractStart).toBeLessThan(10_000);

    await controller.teardown();
  }, 240_000);

  it('selects dropdown options by label or value and rejects unknown options', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'select-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/select-form`);
    const observation = await controller.observe();
    const country = observation.interactables.find((entry) => entry.name === 'Country')!;
    // Visible label resolves to the option's value, with change events fired.
    const byLabel = await controller.fill(country.ref, 'United States');
    expect(byLabel.title).toBe('picked:us');
    const byValue = await controller.fill(country.ref, 'de');
    expect(byValue.title).toBe('picked:de');
    await expect(controller.fill(country.ref, 'France')).rejects.toMatchObject({
      code: 'OPTION_NOT_FOUND',
    } satisfies Partial<BrowserActionabilityError>);
    await controller.teardown();
  }, 45_000);

  it('derives a ranked locator chain from the live element', async () => {
    // The chain a promoted workflow replays. It must come from the locator
    // engine's own ranker, not from the observation scanner's simplified role
    // map — see `locatorFor`.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'locator-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(baseUrl);
    const observation = await controller.observe();
    const signIn = observation.interactables.find((entry) => entry.name === 'Sign in')!;

    const chain = await controller.locatorFor(signIn.ref);

    // Ranked best-first, more than one candidate, terminated by a structural
    // last resort so a single miss is survivable.
    expect(chain.length).toBeGreaterThan(1);
    expect(chain).toContainEqual({ kind: 'role', role: 'button', name: 'Sign in' });
    expect(chain.at(-1)?.kind).toBe('xpath');
    await controller.teardown();
  }, 45_000);

  it('derives a listbox role for a <select>, matching what replay computes', async () => {
    // Regression: the observation scanner calls `<select>` a `combobox`, but
    // the locator engine computes `listbox`. A chain built from the scanner's
    // role pinned a role that could never match, so every recorded dropdown
    // failed replay with "locator not found" on an unchanged page.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'locator-select-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/select-form`);
    const observation = await controller.observe();
    const country = observation.interactables.find((entry) => entry.name === 'Country')!;

    // The model-facing observation still reports the scanner's simpler role...
    expect(country.role).toBe('combobox');
    // ...but the persisted locator is expressed in the resolver's terms.
    const chain = await controller.locatorFor(country.ref);
    expect(chain).toContainEqual({ kind: 'role', role: 'listbox', name: 'Country' });
    await controller.teardown();
  }, 45_000);

  it('returns an empty chain for a stale ref instead of throwing', async () => {
    // A locator is a nice-to-have for the trace; it must never fail the action
    // the agent is performing.
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'locator-stale-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(baseUrl);
    await controller.observe();

    await expect(controller.locatorFor('e9999')).resolves.toEqual([]);
    await controller.teardown();
  }, 45_000);

  it('replaces an existing value and types long values within budget', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'overtype-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const username = observation.interactables.find((entry) => entry.name === 'Username')!;
    await controller.fill(username.ref, 'first value');
    // Long values drop the per-key delay (the old fixed 100ms/char made a
    // large fill take minutes) and must still fully replace what was there.
    const long = 'x'.repeat(300);
    await controller.fill(username.ref, long);
    const typed = await tracked.page!.puppeteerPage!.evaluate(
      () => document.querySelector<HTMLInputElement>('input[name="u"]')!.value,
    );
    expect(typed).toBe(long);
    await controller.teardown();
  }, 45_000);

  it('mints fresh ids for a new document instead of aliasing old ones', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'alias-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const first = await controller.observe();
    await controller.navigate(`${baseUrl}/next`);
    const next = await controller.observe();
    expect(next.interactables.length).toBeGreaterThan(0);
    const firstIds = new Set(first.interactables.map((entry) => entry.ref));
    for (const entry of next.interactables) {
      expect(firstIds.has(entry.ref)).toBe(false);
    }
    await controller.teardown();
  }, 45_000);

  it('reports an element that left the DOM as stale at action time', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'vanish-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const vanish = observation.interactables.find((entry) => entry.name === 'Vanish')!;
    await controller.click(vanish.ref);
    await expect(controller.click(vanish.ref)).rejects.toThrow('element left the page');
    await controller.teardown();
  }, 45_000);

  it('heals click, fill, and evaluateOn once by exact role/name/group identity', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'identity-heal-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const mutate = observation.interactables.find((entry) => entry.name === 'Mutate')!;
    const username = observation.interactables.find((entry) => entry.name === 'Username')!;
    const hideable = observation.interactables.find((entry) => entry.name === 'Hideable field')!;

    await tracked.page!.puppeteerPage!.evaluate(() => {
      for (const selector of ['button[onclick*="state"]', 'input[name="u"]', '#hideable']) {
        const previous = document.querySelector(selector)!;
        previous.replaceWith(previous.cloneNode(true));
      }
    });

    await controller.click(mutate.ref);
    await controller.fill(username.ref, 'healed value');
    const evaluated = await controller.evaluateOn(hideable.ref, (element) => {
      element.dataset['healed'] = 'yes';
      return element.getAttribute('aria-label');
    });

    expect(evaluated).toBe('Hideable field');
    expect(await controller.locatorFor(mutate.ref)).not.toEqual([]);
    expect(
      await tracked.page!.puppeteerPage!.evaluate(() => ({
        state: document.querySelector('#state')!.textContent,
        username: document.querySelector<HTMLInputElement>('input[name="u"]')!.value,
        evaluated: document.querySelector<HTMLElement>('#hideable')!.dataset['healed'],
      })),
    ).toEqual({ state: 'changed', username: 'healed value', evaluated: 'yes' });
    await controller.teardown();
  }, 45_000);

  it('exposes a single non-healing click attempt to retry-owning callers', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'single-click-attempt-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const mutate = observation.interactables.find((entry) => entry.name === 'Mutate')!;

    await tracked.page!.puppeteerPage!.evaluate(() => {
      const previous = document.querySelector('button[onclick*="state"]')!;
      previous.replaceWith(previous.cloneNode(true));
    });

    await expect(controller.click(mutate.ref, { healStale: false })).rejects.toBeDefined();
    expect(
      await tracked.page!.puppeteerPage!.evaluate(
        () => document.querySelector('#state')!.textContent,
      ),
    ).not.toBe('changed');
    await controller.teardown();
  }, 45_000);

  it('heals to the first of several elements that now share one identity', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'identity-ambiguous-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const vanish = observation.interactables.find((entry) => entry.name === 'Vanish')!;
    await tracked.page!.puppeteerPage!.evaluate(() => {
      const previous = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Vanish',
      )!;
      const first = previous.cloneNode(true) as HTMLElement;
      first.id = 'vanish-first';
      const second = previous.cloneNode(true) as HTMLElement;
      second.id = 'vanish-second';
      previous.replaceWith(first, second);
    });

    // Opening a widget routinely mounts a second copy of the control that
    // opened it, and refusing there stranded the caller on exactly the pages
    // where recovery matters. The copies are interchangeable, so document order
    // settles it; this re-finds a control the caller already named rather than
    // deciding which control they meant.
    await expect(controller.click(vanish.ref)).resolves.toBeDefined();
    expect(
      await tracked.page!.puppeteerPage!.evaluate(
        () => document.querySelector('#vanish-first') === null,
      ),
    ).toBe(true);
    await controller.teardown();
  }, 45_000);

  it('still heals a ref after an in-page route change replaced the control', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'identity-history-nav-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/history-nav`);
    const observation = await controller.observe();
    const pick = observation.interactables.find((entry) => entry.name === 'Check-in')!;

    // The click pushes a URL and re-mounts the button, so the navigation-commit
    // event fires even though the document never changed. Discarding identities
    // there is what left the caller with an unhealable ref on single-page sites.
    await controller.click(pick.ref);
    await expect(controller.click(pick.ref)).resolves.toBeDefined();

    expect(await tracked.page!.puppeteerPage!.url()).toContain('picked=1');
    await controller.teardown();
  }, 45_000);

  it('refuses stale-ref healing once the document itself has been replaced', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'identity-new-document-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const vanish = observation.interactables.find((entry) => entry.name === 'Vanish')!;

    // A real load discards the marker stamped on the previous document, so a
    // same-named control on the next page is a different control and must not
    // be adopted — unlike an in-page route change, where everything stays put.
    await controller.navigate(`${baseUrl}/second`);

    await expect(controller.click(vanish.ref)).rejects.toThrow(
      'the page navigated to a new document',
    );
    await controller.teardown();
  }, 45_000);

  it('does not rescan for non-stale actionability failures', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'identity-non-stale-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const disabled = observation.interactables.find((entry) => entry.name === 'Disabled action')!;
    const observe = vi.spyOn(controller, 'observe');

    await expect(controller.click(disabled.ref)).rejects.toMatchObject({
      code: 'ELEMENT_DISABLED',
    });
    expect(observe).not.toHaveBeenCalled();
    await controller.teardown();
  }, 45_000);

  it('bounds and sanitizes observations with stable ranked interactable caps', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'observe-run',
      browserProvider: tracked.provider,
      logger,
      maxDigestBytes: 1_024,
      maxInteractables: 20,
    });
    await controller.navigate(`${baseUrl}/`);
    await tracked.page!.puppeteerPage!.evaluate(() => {
      document.querySelector<HTMLInputElement>('input[name="u"]')!.value = 'Frisco, Texas';
      document.querySelector<HTMLInputElement>('input[name="p"]')!.value = 'hunter2';
      document
        .querySelector<HTMLButtonElement>('button[onclick*="hideable"]')!
        .setAttribute('aria-expanded', 'false');
    });
    const observation = await controller.observe();
    expect(Buffer.byteLength(observation.digest, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(observation.digest).not.toContain('admin@example.com');
    expect(observation.digest).not.toContain('sk-ABCDEF0123456789abcdef01');
    expect(observation.interactables).toHaveLength(20);
    expect(observation.interactables.find((entry) => entry.name === 'Username')).toMatchObject({
      value: 'Frisco, Texas',
    });
    expect(observation.interactables.find((entry) => entry.name === 'Password')).toMatchObject({
      value_present: true,
    });
    expect(JSON.stringify(observation)).not.toContain('hunter2');
    expect(
      observation.interactables.find((entry) => entry.name === 'Disabled action'),
    ).toMatchObject({ disabled: true });
    expect(observation.interactables.find((entry) => entry.name === 'Hide it')).toMatchObject({
      expanded: false,
    });
    const second = await controller.observe();
    expect(second.digest).toBe('');
    expect(second.digestUnchanged).toBe(true);
    expect(second.interactables.map((entry) => entry.name)).toEqual(
      observation.interactables.map((entry) => entry.name),
    );
    await controller.teardown();
  }, 45_000);

  it('does not let an internal observation consume the model-visible digest', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'digest-tracking-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);

    const internal = await controller.observe({ cap: 400, trackDigest: false });
    const visible = await controller.observe();
    expect(internal.digest).not.toBe('');
    expect(visible.digest).not.toBe('');
    expect(visible.digestUnchanged).toBe(false);

    await controller.navigate(`${baseUrl}/`);
    const afterNavigation = await controller.observe();
    expect(afterNavigation.digest).not.toBe('');
    expect(afterNavigation.digestUnchanged).toBe(false);
    await controller.teardown();
  }, 45_000);

  it('returns structured actionability errors for disabled and hidden refs', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'action-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const disabled = observation.interactables.find((entry) => entry.name === 'Disabled action')!;
    const ariaDisabled = observation.interactables.find(
      (entry) => entry.name === 'Aria disabled action',
    )!;
    const hide = observation.interactables.find((entry) => entry.name === 'Hide it')!;
    const hideable = observation.interactables.find((entry) => entry.name === 'Hideable field')!;
    await expect(controller.click(disabled.ref)).rejects.toMatchObject({
      code: 'ELEMENT_DISABLED',
    } satisfies Partial<BrowserActionabilityError>);
    await expect(controller.click(ariaDisabled.ref)).rejects.toMatchObject({
      code: 'ELEMENT_DISABLED',
    } satisfies Partial<BrowserActionabilityError>);
    // Hidden after the observation that minted the ref — the realistic path,
    // since the observer never reports an already-invisible element.
    await controller.click(hide.ref);
    await expect(controller.click(hideable.ref)).rejects.toMatchObject({
      code: 'ELEMENT_HIDDEN',
    } satisfies Partial<BrowserActionabilityError>);
    await expect(controller.fill(hideable.ref, 'x')).rejects.toMatchObject({
      code: 'ELEMENT_HIDDEN',
    } satisfies Partial<BrowserActionabilityError>);
    await controller.teardown();
  }, 45_000);

  // Regression: actionability used to hit-test the element's centre point with
  // document.elementFromPoint, whose coordinates are viewport-relative. Every
  // element below the fold scored as intercepted and was rejected as occluded,
  // even though Puppeteer scrolls the target into view before acting.
  it('acts on elements far below the fold instead of rejecting them', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'fold-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/tall`);
    const observation = await controller.observe();
    const button = observation.interactables.find((entry) => entry.name === 'Below fold')!;
    const field = observation.interactables.find((entry) => entry.name === 'Below fold field')!;
    expect(button).toBeDefined();
    expect(field).toBeDefined();
    await expect(controller.click(button.ref)).resolves.toMatchObject({ title: 'Tall' });
    await expect(controller.fill(field.ref, 'typed')).resolves.toMatchObject({ title: 'Tall' });
    expect(await controller.extract('content')).toMatchObject({
      text: expect.stringContaining('clicked below fold') as string,
    });
    await controller.teardown();
  }, 45_000);

  // INVERTED by FEAT-033. This case used to assert that a covered element was
  // clicked through to the overlay "without erroring" — a silent false success
  // on the agent's most-used tool. The click point is now tested before it is
  // dispatched, and a covered control says so.
  it('refuses a covered element as obstructed rather than clicking the overlay', async () => {
    const controller = await open('covered-run', '/');
    const observation = await controller.observe();
    const covered = observation.interactables.find((entry) => entry.name === 'Covered action')!;
    const error = await controller.click(covered.ref).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    const actionability = error as BrowserActionabilityError;
    expect(actionability.code).toBe('ELEMENT_OBSTRUCTED');
    // A covered element is visible; conflating the two would send the agent to
    // re-observe when the fix is to dismiss.
    expect(actionability.code).not.toBe('ELEMENT_HIDDEN');
    expect(actionability.details?.kind).toBe('fixed-overlay');
    await controller.teardown();
  }, 45_000);

  it('acts on quads whose centre lies outside the viewport', async () => {
    // The two shapes `receivesPointerEvents` cannot satisfy: an element taller
    // than the viewport, and one whose first content quad is clipped.
    const controller = await open('clipped-run', '/clipped');
    const observation = await controller.observe();
    const tall = observation.interactables.find((entry) => entry.name === 'Very tall control')!;
    const wide = observation.interactables.find((entry) => entry.name === 'Very wide control')!;
    await expect(controller.click(tall.ref)).resolves.toMatchObject({ title: 'Tall pressed' });
    await expect(controller.click(wide.ref)).resolves.toMatchObject({ title: 'Wide pressed' });
    await controller.teardown();
  }, 45_000);

  it('dispatches at exactly the coordinate the hit test was given', async () => {
    const controller = await open('coordinate-run', '/');
    const observation = await controller.observe();
    const mutate = observation.interactables.find((entry) => entry.name === 'Mutate')!;
    const handle = controller.resolveRef(mutate.ref);
    const expected = await handle.clickablePoint();
    const page = (controller as unknown as { readonly page: PuppeteerPage }).page;
    const dispatched: { x: number; y: number }[] = [];
    const realClick = page.mouse.click.bind(page.mouse);
    const spy = vi
      .spyOn(page.mouse, 'click')
      .mockImplementation(async (x: number, y: number, options) => {
        dispatched.push({ x, y });
        await realClick(x, y, options);
      });
    try {
      await controller.click(mutate.ref);
    } finally {
      spy.mockRestore();
    }
    // The assertion that fails the moment `dispatchAt` is replaced by
    // `handle.click()`, which recomputes its own point.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.x).toBeCloseTo(expected.x, 5);
    expect(dispatched[0]!.y).toBeCloseTo(expected.y, 5);
    await controller.teardown();
  }, 45_000);

  it('classifies a sticky band, a busy overlay and a modal by structure alone', async () => {
    const sticky = await open('sticky-run', '/obstructed-sticky');
    const stickyObservation = await sticky.observe();
    const band = stickyObservation.interactables.find((entry) => entry.name === 'Under the band')!;
    const stickyError = (await sticky
      .click(band.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(stickyError.code).toBe('ELEMENT_OBSTRUCTED');
    expect(stickyError.details?.kind).toBe('fixed-overlay');
    // A pinned band has no dismiss control inside it — that is the pattern.
    expect(stickyError.details?.candidates).toEqual([]);
    expect(stickyError.details?.clearance_skipped).toBe('no-eligible-candidate');
    await sticky.teardown();

    const busy = await open('busy-run', '/obstructed-busy');
    const busyObservation = await busy.observe();
    const spinner = busyObservation.interactables.find(
      (entry) => entry.name === 'Under the spinner',
    )!;
    const busyError = (await busy
      .click(spinner.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(busyError.code).toBe('ELEMENT_OBSTRUCTED');
    expect(busyError.details?.kind).toBe('busy-indicator');
    expect(busyError.details?.clearance_attempted).toBe(false);
    expect(busyError.details?.clearance_skipped).toBe('never-dismissed-kind');
    // A busy indicator is the one kind the shared retry may spend an attempt on.
    expect(classifyFailure('ELEMENT_OBSTRUCTED', busyError.details!)).toBe('transient');
    expect(classifyFailure('ELEMENT_OBSTRUCTED', stickyError.details!)).toBe('terminal');
    expect(classifyFailure('ELEMENT_OBSTRUCTED')).toBe('terminal');
    await busy.teardown();
  }, 60_000);

  it('clears one unambiguous modal per call and lands the underlying click', async () => {
    const controller = await open('clearance-run', '/obstructed');
    const observation = await controller.observe();
    const under = observation.interactables.find((entry) => entry.name === 'Under the modal')!;
    controller.beginToolCall();
    const result = await controller.click(under.ref);
    expect(result.title).toBe('Under pressed');
    // The clearance is on the ledger like every other recovery step, so a click
    // that only landed because an overlay was dismissed says so.
    expect(result.attempted).toEqual([
      expect.objectContaining({ strategy: 'clear-obstruction', axis: 'where', errorCode: null }),
    ]);
    await controller.teardown();
  }, 45_000);

  it('offers refs from the obstructing subtree only, and never presses a guarded one', async () => {
    const controller = await open('candidates-run', '/obstructed-accept-only');
    const observation = await controller.observe();
    const under = observation.interactables.find((entry) => entry.name === 'Under the modal')!;
    const existing = observation.interactables.map((entry) => entry.ref);
    controller.beginToolCall();
    const error = (await controller
      .click(under.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(error.code).toBe('ELEMENT_OBSTRUCTED');
    expect(error.details?.kind).toBe('modal-dialog');
    expect(error.details?.obstruction).toEqual({ role: 'dialog', name: 'Consent required' });
    expect(error.details?.clearance_attempted).toBe(false);
    expect(error.details?.clearance_skipped).toBe('no-eligible-candidate');

    const candidates = error.details?.candidates as readonly {
      readonly ref: string;
      readonly name: string;
      readonly protected: boolean;
      readonly auto_clearable: boolean;
    }[];
    // "Accept all" is not dismissal-shaped at all; "Confirm and close" is, but
    // the protected-action veto keeps it un-pressable.
    expect(candidates.map((entry) => entry.name)).toEqual(['Confirm and close']);
    expect(candidates[0]).toMatchObject({ protected: true, auto_clearable: false });
    // Minting is additive: it never invalidates the caller's own ref and never
    // renumbers one that already existed.
    for (const ref of existing) expect(() => controller.resolveRef(ref)).not.toThrow();
    expect(existing).not.toContain(candidates[0]!.ref);
    // An offered ref is a ref the controller resolves and a click can act on —
    // which is what makes naming it in a hint legal at all.
    expect(controller.describeRef(candidates[0]!.ref)).toMatchObject({
      role: 'button',
      name: 'Confirm and close',
    });
    await expect(controller.click(candidates[0]!.ref)).resolves.toMatchObject({
      title: 'Accept only',
    });
    await controller.teardown();
  }, 45_000);

  it('spends one clearance per tool call and refuses a modal that re-raises itself', async () => {
    const controller = await open('rerender-run', '/obstructed-rerender');
    const observation = await controller.observe();
    const under = observation.interactables.find((entry) => entry.name === 'Under the modal')!;
    controller.beginToolCall();
    const first = (await controller
      .click(under.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(first.code).toBe('ELEMENT_OBSTRUCTED');
    expect(first.details?.clearance_attempted).toBe(true);
    expect(first.details?.clearance_result).toBe('still-obstructed');
    // Same call, second action: the allowance is already spent.
    const second = (await controller
      .click(under.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(second.details?.clearance_attempted).toBe(false);
    expect(second.details?.clearance_skipped).toBe('already-spent-this-call');
    // A new top-level tool call gets its own allowance.
    controller.beginToolCall();
    const third = (await controller
      .click(under.ref)
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(third.details?.clearance_attempted).toBe(true);
    await controller.teardown();
  }, 60_000);

  it('applies the guarantee to a pointer fill and leaves the value-based one alone', async () => {
    const controller = await open('obstructed-fill-run', '/obstructed-field');
    const observation = await controller.observe();
    const text = observation.interactables.find((entry) => entry.name === 'Covered field')!;
    const select = observation.interactables.find((entry) => entry.name === 'Covered select')!;
    controller.beginToolCall();
    const error = (await controller
      .fill(text.ref, 'typed')
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    expect(error.code).toBe('ELEMENT_OBSTRUCTED');
    // The misdiagnosis this replaces: a covered field used to degrade into a
    // widget that "did not commit".
    expect(error.code).not.toBe('WIDGET_NOT_COMMITTED');
    // A native <select> is filled by value, not by pointer, so the pointer
    // guarantee does not — and must not — reach it.
    await expect(controller.fill(select.ref, 'Beta')).resolves.toMatchObject({
      title: 'Obstructed field',
    });
    await controller.teardown();
  }, 45_000);

  it('lets the existing recovery own an overlay that arrives mid-dispatch', async () => {
    // The overlay is inserted by a mousemove listener, so it arrives between the
    // hover that scrolls and the point that is tested. No new mechanism handles
    // this: it resolves through the report the pre-flight already produces.
    const controller = await open('late-overlay-run', '/late-overlay');
    const observation = await controller.observe();
    const target = observation.interactables.find((entry) => entry.name === 'Target')!;
    controller.beginToolCall();
    const outcome: unknown = await controller.click(target.ref).catch((thrown: unknown) => thrown);
    if (outcome instanceof Error) {
      expect((outcome as BrowserActionabilityError).code).toBe('ELEMENT_OBSTRUCTED');
    } else {
      expect(outcome).toMatchObject({ title: 'Under pressed' });
    }
    await controller.teardown();
  }, 45_000);

  it('pays for the obstruction-scoped read only on the path that needs it', async () => {
    // Memory requires diagnostic work to be paid for only on the path that
    // needs it, and to be asserted by counting: a silent extra page read is
    // invisible in every other signal.
    const clear = await open('read-accounting-clear-run', '/');
    const clearObservation = await clear.observe();
    const mutate = clearObservation.interactables.find((entry) => entry.name === 'Mutate')!;
    const clearReads = vi.spyOn(clear, 'evaluate');
    clear.beginToolCall();
    await clear.click(mutate.ref);
    expect(clearReads).not.toHaveBeenCalled();
    await clear.teardown();

    const blocked = await open('read-accounting-blocked-run', '/obstructed-accept-only');
    const blockedObservation = await blocked.observe();
    const under = blockedObservation.interactables.find(
      (entry) => entry.name === 'Under the modal',
    )!;
    const blockedReads = vi.spyOn(blocked, 'evaluate');
    blocked.beginToolCall();
    await blocked.click(under.ref).catch(() => undefined);
    expect(blockedReads).toHaveBeenCalledTimes(1);
    await blocked.teardown();
  }, 60_000);

  it('shares one clearance across every field of a multi-field tool call', async () => {
    // `browser_fill_form` is one top-level tool call spanning many fields and
    // many typing rungs. The allowance is scoped to the call, not the action, so
    // a batch cannot press its way through a page one field at a time.
    const controller = await open('two-field-run', '/obstructed-two-fields');
    const observation = await controller.observe();
    const first = observation.interactables.find((entry) => entry.name === 'First field')!;
    const second = observation.interactables.find((entry) => entry.name === 'Second field')!;
    controller.beginToolCall();
    const firstError = (await controller
      .fill(first.ref, 'alpha')
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;
    const secondError = (await controller
      .fill(second.ref, 'beta')
      .catch((thrown: unknown) => thrown)) as BrowserActionabilityError;

    expect(firstError.details?.clearance_attempted).toBe(true);
    expect(secondError.details?.clearance_attempted).toBe(false);
    expect(secondError.details?.clearance_skipped).toBe('already-spent-this-call');
    const presses = [firstError, secondError].filter(
      (error) => error.details?.clearance_attempted === true,
    ).length;
    expect(presses).toBe(1);
    await controller.teardown();
  }, 60_000);

  it('binds every ref to the element it was described from, across shadow boundaries', async () => {
    const controller = await open('composed-align-run', '/composed-shadow');
    try {
      const observation = await controller.observe();

      // The alignment invariant, read back off the live handles. On a flat-tree
      // handle query this page necessarily misaligns: `page.$$` cannot see the
      // shadow-hosted button, so every index past the first host names a
      // different element than the record it was paired with.
      for (const interactable of observation.interactables) {
        const live = await controller.evaluateOn(interactable.ref, (element) => ({
          role: element.tagName.toLowerCase(),
          name: (element.textContent ?? '').trim(),
        }));
        expect(live.name).toBe(interactable.name);
        expect(live.role).toBe('button');
      }

      const names = observation.interactables.map((entry) => entry.name);
      expect(names).toContain('Shadow open');
      expect(names).toContain('Light one');
      expect(names).toContain('Light two');
      // A closed root is not filtered — the platform withholds it, so the
      // control is absent from observation. That is the correct outcome, and
      // deliberately not a capability gap to be worked around.
      expect(names).not.toContain('Shadow closed');
    } finally {
      await controller.teardown();
    }
  }, 45_000);

  it('resolves a shadow-hosted ref to a handle rooted in its shadow tree', async () => {
    const controller = await open('composed-root-run', '/composed-shadow');
    try {
      const observation = await controller.observe();
      const shadow = observation.interactables.find((entry) => entry.name === 'Shadow open')!;
      const light = observation.interactables.find((entry) => entry.name === 'Light one')!;

      expect(
        await controller.evaluateOn(
          shadow.ref,
          (element) => element.getRootNode() !== element.ownerDocument,
        ),
      ).toBe(true);
      expect(
        await controller.evaluateOn(
          light.ref,
          (element) => element.getRootNode() === element.ownerDocument,
        ),
      ).toBe(true);
    } finally {
      await controller.teardown();
    }
  }, 45_000);

  it('keeps a shadow-hosted ref identity stable across observations of one document', async () => {
    const controller = await open('composed-identity-run', '/composed-shadow');
    try {
      const first = await controller.observe();
      const second = await controller.observe();
      const refFor = (observation: { interactables: readonly { ref: string; name: string }[] }) =>
        observation.interactables.find((entry) => entry.name === 'Shadow open')?.ref;

      expect(refFor(first)).toBeDefined();
      expect(refFor(second)).toBe(refFor(first));
    } finally {
      await controller.teardown();
    }
  }, 45_000);

  it('acts on an attached shadow-hosted element and stales it once its root drops it', async () => {
    const controller = await open('composed-stale-run', '/composed-shadow');
    try {
      const observation = await controller.observe();
      const ref = observation.interactables.find(
        (entry) => entry.name === 'Shadow detachable',
      )!.ref;

      // Attached inside a shadow tree: `isConnected` is true, so the existing
      // actionability contract needs no shadow-specific branch.
      await expect(controller.click(ref)).resolves.toBeDefined();

      await controller.evaluate(() => {
        const root = (window as unknown as { __detachable: ShadowRoot }).__detachable;
        root.firstElementChild?.remove();
      });
      await expect(controller.click(ref)).rejects.toThrow(StaleElementRefError);
    } finally {
      await controller.teardown();
    }
  }, 45_000);

  it('exposes no internal traversal field to the model, and leaks no handle per observation', async () => {
    const controller = await open('composed-payload-run', '/composed-shadow');
    try {
      const observation = await controller.observe();
      const serialized = JSON.stringify(observation.interactables);
      for (const internal of ['composedScope', 'elementIndex', 'rootNodeDepth', 'selectorIndex']) {
        expect(serialized).not.toContain(internal);
      }
      expect(
        JSON.stringify(controller.describeRef(observation.interactables[0]!.ref)),
      ).not.toContain('composedScope');

      // Handle accounting: repeated observations of one document must not grow
      // the live handle set. A silently retained handle per observation is
      // invisible in every other signal.
      const countHandles = async (): Promise<number> =>
        (await controller.evaluate(() => document.querySelectorAll('button').length)) as number;
      const before = await countHandles();
      for (let index = 0; index < 4; index += 1) await controller.observe();
      const after = await controller.observe();
      expect(await countHandles()).toBe(before);
      expect(after.interactables.length).toBe(observation.interactables.length);
    } finally {
      await controller.teardown();
    }
  }, 60_000);

  /** Launch a controller on one fixture route. */
  describe('page-delta observation', () => {
    it('adds no page read at all, on the observation or on a whole click', async () => {
      // Memory's hard rule: diagnostic work is paid for only on the path that
      // needs it, and it is asserted by *counting*, because a silent extra page
      // read is invisible in every other signal. The counts below are the
      // frozen baseline for one `observe()`: locator injection, the title/HTML
      // read, and the document stamp are the three `evaluate` calls, and the
      // composed scan is the one `evaluateHandle`. The fingerprint adds none of
      // them — it is derived in-process from the scan the observation was
      // already taking, and the document epoch is a read-or-mint on the
      // `evaluate` that already ran. Anyone who later adds a fingerprint-only
      // read has to change this number to land it.
      const tracked = trackingProvider();
      const controller = new AgentBrowserController({
        runId: 'delta-read-accounting-run',
        browserProvider: tracked.provider,
        logger,
      });
      await controller.navigate(`${baseUrl}/`);
      const puppeteerPage = tracked.page!.puppeteerPage!;
      // The puppeteer page is the single point every route passes through: the
      // facade's `evaluate`, the controller's own `evaluate`, and the composed
      // scan's `evaluateHandle` all bottom out here.
      const evaluate = vi.spyOn(puppeteerPage, 'evaluate');
      const evaluateHandle = vi.spyOn(puppeteerPage, 'evaluateHandle');
      const query = vi.spyOn(puppeteerPage, '$$');

      await controller.observe();

      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(evaluateHandle).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();

      // And a whole action, the way a wrapped tool performs one: the action
      // plus exactly one post-action observation.
      const observation = await controller.observe();
      const mutate = observation.interactables.find((entry) => entry.name === 'Mutate')!;
      const observations = vi.spyOn(controller, 'observe');
      controller.beginToolCall();
      await controller.click(mutate.ref);
      await controller.observe();
      // `vi.spyOn(instance, ...)` rather than an outer proxy: a proxy around the
      // controller cannot see the reads the controller takes on its own behalf.
      expect(observations).toHaveBeenCalledTimes(1);
      expect(controller.deltaSinceBaseline()).not.toBeNull();

      await controller.teardown();
    }, 60_000);

    it('keeps one epoch per document and mints a new one only on a real navigation', async () => {
      const controller = await open('delta-epoch-run', '/');
      const first = await controller.observe();
      const second = await controller.observe();
      // Two observations of one document are comparable, so no replacement is
      // claimed however many times the page is read.
      expect(controller.deltaSinceBaseline()?.incomplete).toBeUndefined();
      expect(first.url).toBe(second.url);

      controller.beginToolCall();
      await controller.navigate(`${baseUrl}/next`);
      await controller.observe();
      const delta = controller.deltaSinceBaseline()!;

      expect(delta.incomplete).toEqual(['document-replaced']);
      expect(delta.complete).toBe(false);
      expect(delta.url_changed).toEqual({
        from: `${baseUrl}/`,
        to: `${baseUrl}/next`,
      });
      expect(delta.elements_appeared).toBeUndefined();
      expect(delta.elements_vanished).toBeUndefined();
      await controller.teardown();
    }, 60_000);

    it('reports a null epoch without throwing when the page refuses the stamp', async () => {
      const controller = await open('delta-refused-stamp-run', '/refuses-stamp');
      controller.beginToolCall();
      await expect(controller.observe()).resolves.toBeDefined();
      await controller.observe();

      // No stamp means no evidence of replacement — which is not the same as
      // evidence of replacement.
      expect(controller.deltaSinceBaseline()?.incomplete).toBeUndefined();
      await controller.teardown();
    }, 60_000);

    it('leaves the delta baseline to model-visible observations alone', async () => {
      const controller = await open('delta-baseline-run', '/delta-dialog');
      await controller.observe();
      const opener = (await controller.observe()).interactables.find(
        (entry) => entry.name === 'Open preferences',
      )!;
      controller.beginToolCall();
      await controller.click(opener.ref);
      // An internal resolution read, taken *after* the page changed. It must
      // not become the baseline, or the delta would report the difference from
      // a frame the model was never shown — which is nothing at all.
      await controller.observe({ cap: 400, trackDigest: false });
      await controller.observe();

      const delta = controller.deltaSinceBaseline()!;
      expect(delta.dialogs_opened).toEqual([{ role: 'dialog', name: 'Cookie consent' }]);
      await controller.teardown();
    }, 60_000);

    it('omits the delta entirely when there is no baseline to diff against', async () => {
      const tracked = trackingProvider();
      const controller = new AgentBrowserController({
        runId: 'delta-no-baseline-run',
        browserProvider: tracked.provider,
        logger,
      });
      controller.beginToolCall();
      await controller.navigate(`${baseUrl}/`);
      await controller.observe();

      // The ordinary state of the first navigation in a run: the model has seen
      // no frame, so there is nothing to diff, and an empty block would read as
      // "nothing changed".
      expect(controller.deltaSinceBaseline()).toBeNull();
      await controller.teardown();
    }, 60_000);

    it('reports a dialog opening and closing against real layout', async () => {
      const controller = await open('delta-dialog-run', '/delta-dialog');
      const consent = { role: 'dialog', name: 'Cookie consent' };
      await controller.observe();
      const opener = (await controller.observe()).interactables.find(
        (entry) => entry.name === 'Open preferences',
      )!;
      controller.beginToolCall();
      await controller.click(opener.ref);
      const opened = await controller.observe();
      expect(controller.deltaSinceBaseline()?.dialogs_opened).toEqual([consent]);

      const close = opened.interactables.find((entry) => entry.name === 'Close')!;
      controller.beginToolCall();
      await controller.click(close.ref);
      await controller.observe();
      const closedDelta = controller.deltaSinceBaseline()!;

      expect(closedDelta.dialogs_closed).toEqual([consent]);
      expect(closedDelta.dialogs_opened).toBeUndefined();
      await controller.teardown();
      // Two full click-and-observe cycles against real Chrome, where every
      // other case here does one. The suite's 60s allowance is enough in
      // isolation and not under full-suite CPU load.
    }, 120_000);

    it('reports nothing when same-named controls reorder and demonstrably trade refs', async () => {
      // The single most valuable assertion in this feature: this is exactly the
      // failure a ref-based delta would ship silently.
      const controller = await open('delta-reorder-run', '/delta-reorder');
      await controller.observe();
      const before = await controller.observe();
      const shuffle = before.interactables.find((entry) => entry.name === 'Shuffle')!;
      const beforeSelects = before.interactables.filter((entry) => entry.name === 'Select');

      controller.beginToolCall();
      await controller.click(shuffle.ref);
      const after = await controller.observe();
      const delta = controller.deltaSinceBaseline()!;

      // The refs really did change hands — otherwise this route proves nothing.
      const afterSelects = after.interactables.filter((entry) => entry.name === 'Select');
      expect(afterSelects).toHaveLength(beforeSelects.length);
      expect(afterSelects.map((entry) => entry.ref)).not.toEqual(
        beforeSelects
          .map((entry) => entry.ref)
          .slice()
          .reverse(),
      );
      expect(delta.elements_appeared).toBeUndefined();
      expect(delta.elements_vanished).toBeUndefined();
      expect(delta.incomplete).toBeUndefined();
      await controller.teardown();
    }, 60_000);

    it('reports nothing when a control set is remounted identically', async () => {
      const controller = await open('delta-remount-run', '/delta-remount');
      await controller.observe();
      const refresh = (await controller.observe()).interactables.find(
        (entry) => entry.name === 'Refresh results',
      )!;

      controller.beginToolCall();
      await controller.click(refresh.ref);
      await controller.observe();
      const delta = controller.deltaSinceBaseline()!;

      expect(delta.elements_appeared).toBeUndefined();
      expect(delta.elements_vanished).toBeUndefined();
      await controller.teardown();
    }, 60_000);

    it('reports nothing vanished for elements the model-visible cap had to drop', async () => {
      const controller = await open('delta-over-cap-run', '/delta-over-cap');
      await controller.observe();
      const capped = await controller.observe();
      // The page really does exceed the cap; otherwise this proves nothing.
      expect(capped.interactables.length).toBeLessThan(81);

      controller.beginToolCall();
      const filler = capped.interactables.find((entry) => entry.name === 'Filler 00')!;
      await controller.click(filler.ref);
      await controller.observe();
      const delta = controller.deltaSinceBaseline()!;

      expect(delta.elements_vanished).toBeUndefined();
      expect(delta.elements_appeared).toBeUndefined();
      await controller.teardown();
    }, 60_000);

    it('reports focus moving between two real controls', async () => {
      const controller = await open('delta-focus-run', '/delta-focus');
      await controller.observe();
      const take = (await controller.observe()).interactables.find(
        (entry) => entry.name === 'Take focus',
      )!;

      controller.beginToolCall();
      await controller.click(take.ref);
      await controller.observe();
      const delta = controller.deltaSinceBaseline()!;

      expect(delta.focus_moved).toEqual({
        from: { role: 'textbox', name: 'Origin' },
        to: { role: 'button', name: 'Take focus' },
      });
      await controller.teardown();
    }, 60_000);

    it('drains action metadata without taking a page read', async () => {
      const controller = await open('delta-metadata-run', '/dynamic-popup');
      const observation = await controller.observe();
      const opener = observation.interactables.find((entry) => entry.name === 'Open dynamic')!;
      controller.beginToolCall();
      await controller.click(opener.ref);

      const evaluate = vi.spyOn(controller, 'evaluate');
      const metadata = controller.takeActionMetadata();

      expect(evaluate).not.toHaveBeenCalled();
      expect(metadata.url).toBe(`${baseUrl}/dynamic-popup`);
      await controller.teardown();
    }, 60_000);
  });

  async function open(runId: string, path: string): Promise<AgentBrowserController> {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId,
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}${path}`);
    return controller;
  }
});

function trackingProvider(): {
  readonly provider: BrowserProvider;
  readonly launch: ReturnType<typeof vi.fn>;
  page: Page | null;
  session: BrowserSession | null;
} {
  const result = {
    page: null as Page | null,
    session: null as BrowserSession | null,
    launch: vi.fn(),
    provider: null as unknown as BrowserProvider,
  };
  const actual = new LocalBrowserProvider({ profileStore: new LocalProfileStore(), logger });
  result.launch.mockImplementation(async (options) => {
    const session = await actual.launch(options);
    result.session = session;
    const newPage = session.newPage.bind(session);
    session.newPage = async () => {
      const page = await newPage();
      result.page = page;
      return page;
    };
    return session;
  });
  result.provider = { launch: result.launch, detectChrome: () => actual.detectChrome() };
  return result;
}
