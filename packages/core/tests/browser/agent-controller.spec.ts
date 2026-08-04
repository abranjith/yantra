import { access } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AgentBrowserController,
  type BrowserActionabilityError,
  isNoLayoutBoxError,
  StaleElementRefError,
} from '../../src/browser/agent-controller.js';
import { isNavigationRaceError, isUnsettleableRequestUrl } from '../../src/browser/page-settle.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserProvider, BrowserSession, Logger, Page } from '../../src/browser/types.js';

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
        response.end('<title>Popup</title><p>popup target</p>');
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(1);
    await controller.teardown();
  }, 45_000);

  it('caps the model-visible observation at 30 but resolves more under an explicit cap', async () => {
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
    const internal = await controller.observe({ cap: 400 });

    expect(modelVisible.interactables).toHaveLength(30);
    expect(internal.interactables.length).toBeGreaterThan(30);
    // The cap is clamped, so an absurd request cannot explode the handle set.
    const clamped = await controller.observe({ cap: 10_000 });
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
    expect(await tracked.page!.puppeteerPage!.browser().pages()).toHaveLength(1);
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
    await expect(controller.click(vanish.ref)).rejects.toThrow(StaleElementRefError);
    await controller.teardown();
  }, 45_000);

  it('bounds and sanitizes observations with stable ranked interactable caps', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'observe-run',
      browserProvider: tracked.provider,
      logger,
      maxDigestBytes: 1_024,
      maxInteractables: 10,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    expect(Buffer.byteLength(observation.digest, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(observation.digest).not.toContain('admin@example.com');
    expect(observation.digest).not.toContain('sk-ABCDEF0123456789abcdef01');
    expect(observation.interactables).toHaveLength(10);
    const second = await controller.observe();
    expect(second.interactables.map((entry) => entry.name)).toEqual(
      observation.interactables.map((entry) => entry.name),
    );
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

  // A covered element is clicked through to whatever covers it, exactly as a
  // real user's click would be. The agent sees that outcome by re-observing;
  // it is not a tool error, so the action must not fail.
  it('clicks a covered element through to the overlay without erroring', async () => {
    const tracked = trackingProvider();
    const controller = new AgentBrowserController({
      runId: 'covered-run',
      browserProvider: tracked.provider,
      logger,
    });
    await controller.navigate(`${baseUrl}/`);
    const observation = await controller.observe();
    const covered = observation.interactables.find((entry) => entry.name === 'Covered action')!;
    await expect(controller.click(covered.ref)).resolves.toMatchObject({
      title: 'Controller fixture',
    });
    await controller.teardown();
  }, 45_000);
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
