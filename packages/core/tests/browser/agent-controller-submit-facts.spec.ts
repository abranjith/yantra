import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserProvider, Logger } from '../../src/browser/types.js';
import { classifySubmitTarget } from '../../src/interaction/submit-class.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * A synthetic page with one control per classification case, plus a counter of
 * every way a form can be submitted, so the test can prove reading the facts
 * never submits anything.
 */
const FIXTURE = `<!doctype html><title>Submit facts</title>
<form id="f" onsubmit="event.preventDefault()">
  <input aria-label="Email" type="email">
  <button>Send now</button>
  <button type="button">Add another</button>
  <input type="image" alt="Go" aria-label="Go" style="width:40px;height:20px;border:1px solid">
</form>
<button form="f">Outside owner</button>
<button>Loose button</button>
<a href="#ticket">Submit a ticket</a>
<div role="button" tabindex="0">Proceed</div>
<script>
  window.__submits = 0;
  document.addEventListener('submit', () => { window.__submits += 1; }, true);
  const requestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.requestSubmit = function (...args) {
    window.__submits += 1;
    return requestSubmit.apply(this, args);
  };
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    window.__submits += 1;
    return submit.apply(this);
  };
</script>`;

describe('@no-llm AgentBrowserController.submitFacts', () => {
  let server: Server;
  let baseUrl: string;
  let fixture: MigrationBrowserFixture;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.cleanup();
  });

  function provider(): BrowserProvider {
    const actual = new LocalBrowserProvider({ profileStore: new LocalProfileStore(), logger });
    return {
      launch: (options) => actual.launch({ ...options, ...fixture.launchOptions }),
      detectChrome: () => actual.detectChrome(),
    };
  }

  it('reads tag, resolved type, and form ownership without submitting anything', async () => {
    const controller = new AgentBrowserController({
      runId: 'submit-facts',
      browserProvider: provider(),
      logger,
    });
    try {
      await controller.navigate(`${baseUrl}/form`);
      const observation = await controller.observe();
      const refOf = (name: string): string => {
        const entry = observation.interactables.find((candidate) => candidate.name === name);
        if (!entry) throw new Error(`fixture control "${name}" was not observed`);
        return entry.ref;
      };
      const classify = async (name: string) =>
        classifySubmitTarget(await controller.submitFacts(refOf(name)), name);

      expect(await controller.submitFacts(refOf('Send now'))).toEqual({
        tag: 'button',
        resolvedType: 'submit',
        hasFormOwner: true,
      });
      expect(await classify('Send now')).toBe('structural');
      expect(await classify('Add another')).toBeNull();
      expect(await classify('Go')).toBe('structural');
      expect(await classify('Outside owner')).toBe('structural');
      expect(await controller.submitFacts(refOf('Loose button'))).toEqual({
        tag: 'button',
        resolvedType: 'submit',
        hasFormOwner: false,
      });
      expect(await classify('Loose button')).toBeNull();
      expect(await classify('Submit a ticket')).toBe('name');
      expect(await classify('Proceed')).toBeNull();
      expect(await controller.submitFacts('e9999')).toBeNull();

      const submits = await controller.evaluate(
        () => (window as unknown as { __submits: number }).__submits,
      );
      expect(submits).toBe(0);
    } finally {
      await controller.teardown();
    }
  }, 60_000);
});
