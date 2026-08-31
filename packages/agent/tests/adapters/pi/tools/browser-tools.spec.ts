import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserActionabilityError,
  EthicsRefusedError,
  StaleElementRefError,
  type AgentBrowserController,
} from '@yantra/core';
import { Compile } from 'typebox/compile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { browserExtractSpec } from '../../../../src/adapters/pi/tools/browser-extract.js';
import { browserFillElementSpec } from '../../../../src/adapters/pi/tools/browser-fill-element.js';
import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import { browserObserveSpec } from '../../../../src/adapters/pi/tools/browser-observe.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps, RunServices } from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import { assertToolContract, buildServices } from './test-support.js';

describe('@no-llm browser tools', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-browser-tools-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('passes the reusable contract harness for all five tools', async () => {
    const services = buildServices();
    await assertToolContract(browserNavigateSpec(services), { url: 42 });
    await assertToolContract(browserObserveSpec(services), { extra: true });
    await assertToolContract(browserClickSpec(services), { ref: 'button.css' });
    // A bare string is now a valid literal value, so the invalid case must use a
    // type the whole value union rejects (neither string nor tagged object).
    await assertToolContract(browserFillElementSpec(services), { field: 'Search', value: 42 });
    // `kind` is a plain string (small models cannot recover from a literal-union
    // rejection raised before the middleware), so the schema-invalid case must
    // use a non-string value.
    await assertToolContract(browserExtractSpec(services), { kind: 42 });
  });

  it('navigates through URL/ethics policy and exposes popup interception', async () => {
    const controller = fakeController();
    controller.navigate.mockResolvedValue({
      url: 'https://example.com/final',
      title: 'Final',
      popup_intercepted: 'https://example.com/popup',
    });
    const services = browserServices(controller);
    const result = await wrapTool(browserNavigateSpec(services), services).execute(
      { url: 'https://example.com/' },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(result.modelText).toContain('popup_intercepted');
  });

  describe('click recovery when the page replaces the element', () => {
    const landed = { url: 'https://example.com/page', title: 'Page' };

    it('re-resolves a ref that went stale and lands the click', async () => {
      const controller = fakeController();
      controller.click
        .mockRejectedValueOnce(new StaleElementRefError('e1'))
        .mockResolvedValueOnce(landed);
      controller.observe.mockResolvedValue({
        url: 'https://example.com/page',
        title: 'Page',
        digest: '',
        digestUnchanged: false,
        interactables: [{ ref: 'e7', role: 'button', name: 'Continue' }],
      });
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(result.status).toBe('ok');
      expect(controller.click).toHaveBeenNthCalledWith(1, 'e1', { healStale: false });
      expect(controller.click).toHaveBeenNthCalledWith(2, 'e7', { healStale: false });
      expect(result.modelText).toContain('re-resolved');
      expect(result.modelText).toContain('re-resolve-ref');
    });

    it('refuses a same-named replacement that carries a different role', async () => {
      // Recovering an identity is not choosing a different element. A link
      // named "Continue" is not the button that vanished.
      const controller = fakeController();
      controller.click.mockRejectedValue(new StaleElementRefError('e1'));
      controller.observe.mockResolvedValue({
        url: 'https://example.com/page',
        title: 'Page',
        digest: '',
        digestUnchanged: false,
        interactables: [{ ref: 'e7', role: 'link', name: 'Continue' }],
      });
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(result.error_code).toBe('STALE_ELEMENT_REF');
      expect(controller.click).toHaveBeenCalledTimes(1);
    });

    it('reports the attempts it made when the element is simply gone', async () => {
      const controller = fakeController();
      controller.click.mockRejectedValue(new StaleElementRefError('e1'));
      controller.observe.mockResolvedValue({
        url: 'https://example.com/page',
        title: 'Page',
        digest: '',
        digestUnchanged: false,
        interactables: [],
      });
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(result.error_code).toBe('STALE_ELEMENT_REF');
      const details = result.details as { readonly attempted?: readonly unknown[] };
      expect(details.attempted?.length).toBeGreaterThan(1);
    });

    it('does not retry a disabled element', async () => {
      const controller = fakeController();
      controller.click.mockRejectedValue(
        new BrowserActionabilityError('ELEMENT_DISABLED', 'The element is disabled.'),
      );
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(result.error_code).toBe('ELEMENT_DISABLED');
      expect(controller.click).toHaveBeenCalledTimes(1);
    });

    it('says nothing about recovery when the first click simply worked', async () => {
      const controller = fakeController();
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(result.status).toBe('ok');
      expect(result.modelText).not.toContain('resolved_by');
      expect(result.modelText).not.toContain('attempted');
    });
  });

  describe('following a tab the site opened', () => {
    /** A click that opened the site's own results tab and held it open. */
    const opened = {
      url: 'https://www.kayak.com/stays',
      title: 'Places to Stay',
      popup_intercepted: 'https://www.kayak.com/hotels/Frisco/2026-09-06;map',
      popup_followable: 'https://www.kayak.com/hotels/Frisco/2026-09-06;map',
    };

    it('continues in the tab and reports the switch instead of the address', async () => {
      // The run this exists for: KAYAK opened its results in a new tab and
      // redirected the page behind them to a partner site, so the URL the tool
      // used to hand back loaded booking.com when the model navigated to it.
      const controller = fakeController();
      controller.click.mockResolvedValue(opened);
      controller.adoptPopup.mockResolvedValue({
        url: 'https://www.kayak.com/hotels/Frisco/2026-09-06;map',
        title: 'Frisco, 9/6 – 9/12',
        switched_to_new_tab: 'https://www.kayak.com/hotels/Frisco/2026-09-06;map',
      });
      const services = browserServices(controller, {}, seeded('https://www.kayak.com/stays'));

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(controller.adoptPopup).toHaveBeenCalledOnce();
      expect(result.modelText).toContain('switched_to_new_tab');
      expect(result.modelText).toContain('Frisco');
      // Two addresses for one destination is how a run navigates back off the
      // tab it just adopted.
      expect(result.modelText).not.toContain('popup_intercepted');
      expect(result.modelText).not.toContain('popup_followable');
    });

    it('leaves the tab alone when the ethics gate refuses it', async () => {
      const controller = fakeController();
      controller.click.mockResolvedValue(opened);
      const services = browserServices(
        controller,
        {
          ethics: {
            check: (url: string) =>
              url.includes('/hotels/')
                ? Promise.reject(
                    new EthicsRefusedError(
                      {
                        host: 'www.kayak.com',
                        rule: 'Disallow: /hotels/',
                        reason: 'robots.txt disallows this path',
                        source: 'robots',
                      },
                      { taskId: 'task', runId: 'run', stepId: 'browser_follow_new_tab' },
                    ),
                  )
                : Promise.resolve(),
          },
        },
        seeded('https://www.kayak.com/stays'),
      );

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(controller.adoptPopup).not.toHaveBeenCalled();
      // The click itself still succeeded, and the address is still offered for
      // the model to decide about explicitly.
      expect(result.status).toBe('ok');
      expect(result.modelText).toContain('popup_intercepted');
      expect(result.modelText).not.toContain('switched_to_new_tab');
    });

    it('leaves an ordinary click untouched', async () => {
      const controller = fakeController();
      const services = browserServices(controller);

      const result = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e1' },
        undefined,
      );

      expect(controller.adoptPopup).not.toHaveBeenCalled();
      expect(result.status).toBe('ok');
    });
  });

  describe('URL provenance', () => {
    /** The fabricated Kayak deep link from run 20260803T033803Z-do-f1d9f01b. */
    const FABRICATED =
      'https://www.kayak.com/hotels/Chicago,IL-c17823/2026-08-05/2026-08-07/1adults;map?sort=price_a';

    it('refuses the exact assembled URL from the logged run', async () => {
      // Provenance holds the hotels index the run legitimately reached; the
      // deep link with the made-up city id `c17823` was never produced by any
      // tool, and it silently served a different city.
      const controller = fakeController();
      const services = browserServices(controller, {}, seeded('https://www.kayak.com/hotels/'));

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: FABRICATED },
        undefined,
      );

      expect(result.error_code).toBe('URL_NOT_FROM_EVIDENCE');
      expect(controller.navigate).not.toHaveBeenCalled();
    });

    it('allows the recorded page without its trailing slash', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({ url: 'https://www.kayak.com/hotels', title: 'H' });
      const services = browserServices(controller, {}, seeded('https://www.kayak.com/hotels/'));

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://www.kayak.com/hotels' },
        undefined,
      );

      expect(result.status).toBe('ok');
    });

    it('allows backing out to the origin of a visited page', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({ url: 'https://www.kayak.com/', title: 'Kayak' });
      const services = browserServices(controller, {}, seeded('https://www.kayak.com/hotels/'));

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://www.kayak.com/' },
        undefined,
      );

      expect(result.status).toBe('ok');
    });

    it('does not spend navigation or host budget on a refusal', async () => {
      // The check runs before `urlPolicy.check`, which reserves budget: a
      // refused guess must not cost a legitimate navigation its slot.
      const controller = fakeController();
      controller.navigate.mockResolvedValue({ url: 'https://example.com/a', title: 'A' });
      const services = buildServices({
        runDir,
        limits: { maxNavigations: 1 },
        urlProvenance: seeded('https://example.com/a'),
        domain: {
          browser: {
            controller: controller as unknown as AgentBrowserController,
            ethics: { check: () => Promise.resolve() },
            secretResolver: null,
            secretHosts: () => Promise.resolve([]),
            captureThresholdBytes: 1024,
          },
        },
      });
      const navigate = wrapTool(browserNavigateSpec(services), services);

      const refused = await navigate.execute({ url: 'https://example.com/guessed' }, undefined);
      const allowed = await navigate.execute({ url: 'https://example.com/a' }, undefined);

      expect(refused.error_code).toBe('URL_NOT_FROM_EVIDENCE');
      expect(allowed.status).toBe('ok');
    });

    it('allows a URL the user wrote in the goal on the first call', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({ url: 'https://track.example.com/x', title: 'T' });
      const provenance = new UrlProvenance();
      provenance.seed({ goal: 'check https://track.example.com/x for me' });
      const services = browserServices(controller, {}, provenance);

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://track.example.com/x' },
        undefined,
      );

      expect(result.status).toBe('ok');
    });

    it('records the redirect target so re-navigating to it later succeeds', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({
        url: 'https://example.com/redirected',
        title: 'Landed',
      });
      const services = browserServices(controller, {}, seeded('https://example.com/start'));
      const navigate = wrapTool(browserNavigateSpec(services), services);

      await navigate.execute({ url: 'https://example.com/start' }, undefined);
      const again = await navigate.execute({ url: 'https://example.com/redirected' }, undefined);

      expect(again.status).toBe('ok');
    });

    it('records an intercepted popup target', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({
        url: 'https://example.com/start',
        title: 'Start',
        popup_intercepted: 'https://example.com/popup',
      });
      const services = browserServices(controller, {}, seeded('https://example.com/start'));
      const navigate = wrapTool(browserNavigateSpec(services), services);

      await navigate.execute({ url: 'https://example.com/start' }, undefined);
      const popup = await navigate.execute({ url: 'https://example.com/popup' }, undefined);

      expect(popup.status).toBe('ok');
    });

    it('records a popup a click intercepted, so the agent can follow the search', async () => {
      // Regression for runs 20260811T023421Z-do-83684cb3 (Priceline) and
      // 20260811T025845Z-do-963e62f1 (KAYAK): the Search button opens the
      // results in a new tab, the controller closes it and reports the URL —
      // and `browser_navigate` then refused that very URL as unattested,
      // because only navigate recorded provenance and popups come from clicks.
      const controller = fakeController();
      controller.click.mockResolvedValue({
        url: 'https://www.kayak.com/hotels',
        title: 'Hotels',
        popup_intercepted: 'https://www.kayak.com/hotels/Frisco-p56772/2026-09-06/2026-09-12',
      });
      const services = browserServices(controller, {}, seeded('https://www.kayak.com/hotels'));

      const clicked = await wrapTool(browserClickSpec(services), services).execute(
        { ref: 'e72' },
        undefined,
      );
      const followed = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://www.kayak.com/hotels/Frisco-p56772/2026-09-06/2026-09-12' },
        undefined,
      );

      expect(clicked.status).toBe('ok');
      expect(clicked.modelText).toContain('popup_intercepted');
      expect(followed.status).toBe('ok');
    });

    it('records where a click landed, so navigating back to that page succeeds', async () => {
      const controller = fakeController();
      controller.click.mockResolvedValue({ url: 'https://example.com/results', title: 'Results' });
      const services = browserServices(controller, {}, seeded('https://example.com/'));

      await wrapTool(browserClickSpec(services), services).execute({ ref: 'e1' }, undefined);
      const back = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://example.com/results' },
        undefined,
      );

      expect(back.status).toBe('ok');
    });

    it('still refuses a URL no click or popup produced', async () => {
      // Attesting action results must not become a blanket grant for the host.
      const controller = fakeController();
      controller.click.mockResolvedValue({
        url: 'https://example.com/results',
        title: 'Results',
        popup_intercepted: 'https://example.com/popup',
      });
      const services = browserServices(controller, {}, seeded('https://example.com/'));

      await wrapTool(browserClickSpec(services), services).execute({ ref: 'e1' }, undefined);
      const guessed = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://example.com/results/invented-id-4821' },
        undefined,
      );

      expect(guessed.error_code).toBe('URL_NOT_FROM_EVIDENCE');
    });

    it('names an actionable remedy in the refusal message', async () => {
      const services = browserServices(fakeController(), {}, new UrlProvenance());

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://example.com/guessed' },
        undefined,
      );

      expect(result.modelText).toContain('web_search');
      expect(result.modelText).toContain('click');
    });
  });

  it('returns a typed refusal when robots blocks navigation', async () => {
    const controller = fakeController();
    const refusal = new EthicsRefusedError(
      { host: 'example.com', rule: 'robots.txt', reason: 'Disallowed', source: 'robots' },
      { taskId: 't', runId: 'r', stepId: 'browser_navigate' },
    );
    const services = browserServices(controller, {
      ethics: { check: () => Promise.reject(refusal) },
    });
    const result = await wrapTool(browserNavigateSpec(services), services).execute(
      { url: 'https://example.com/' },
      undefined,
    );
    expect(result.error_code).toBe('ETHICS_BLOCKED');
    expect(controller.navigate).not.toHaveBeenCalled();
  });

  it('returns a bounded observation and stale-ref failures', async () => {
    const controller = fakeController();
    controller.observe.mockResolvedValue({
      url: 'https://example.com',
      title: 'Page',
      digest: 'hello',
      digestUnchanged: false,
      interactables: [{ ref: 'e1', role: 'button', name: 'Go' }],
    });
    const services = browserServices(controller);
    const observed = await wrapTool(browserObserveSpec(services), services).execute({}, undefined);
    expect(observed.modelText).toContain('"ref":"e1"');
    controller.click.mockRejectedValue(new StaleElementRefError('e1'));
    const clicked = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );
    expect(clicked.error_code).toBe('STALE_ELEMENT_REF');
  });

  it('returns a fresh post-click observation and omits it when the read fails', async () => {
    const controller = fakeController();
    controller.click.mockResolvedValue({ url: 'https://example.com', title: 'Page' });
    controller.observe.mockResolvedValue({
      url: 'https://example.com',
      title: 'Page',
      digest: 'Updated',
      digestUnchanged: false,
      interactables: [{ ref: 'e2', role: 'button', name: 'Next' }],
    });
    const services = browserServices(controller);

    const clicked = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );
    expect(clicked.status).toBe('ok');
    expect(clicked.modelText).toContain('"observation"');
    expect(clicked.modelText).toContain('"ref":"e2"');

    controller.observe.mockRejectedValue(new Error('read failed'));
    const degraded = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );
    expect(degraded.status).toBe('ok');
    expect(degraded.modelText).not.toContain('"observation"');
  });

  it('projects unchanged digests as a flag and omits the empty digest', async () => {
    const controller = fakeController();
    controller.observe.mockResolvedValue({
      url: 'https://example.com',
      title: 'Page',
      digest: '',
      digestUnchanged: true,
      interactables: [],
    });
    const services = browserServices(controller);

    const observed = await wrapTool(browserObserveSpec(services), services).execute({}, undefined);
    const payload = JSON.parse(observed.modelText) as Record<string, unknown>;
    expect(payload.digest_unchanged).toBe(true);
    expect(payload).not.toHaveProperty('digest');
  });

  it('sanitizes page-origin field values before the model sees them', async () => {
    const controller = fakeController();
    controller.observe.mockResolvedValue({
      url: 'https://example.com',
      title: 'Page',
      digest: '',
      digestUnchanged: false,
      interactables: [
        { ref: 'e1', role: 'textbox', name: 'Contact', value: 'outsider@example.com' },
      ],
    });
    const services = browserServices(controller);

    const observed = await wrapTool(browserObserveSpec(services), services).execute({}, undefined);
    expect(observed.modelText).not.toContain('outsider@example.com');
    expect(observed.modelText).toContain('[redacted-email]');
  });

  it('denies a protected click when no confirmation surface is available', async () => {
    const controller = fakeController();
    controller.describeRef.mockReturnValue({ ref: 'e1', role: 'button', name: 'Place order' });
    const services = browserServices(controller);
    const result = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );
    expect(result.status).toBe('denied');
    expect(controller.click).not.toHaveBeenCalled();
  });

  it('extracts tables and stores oversized results as a capture reference', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({
      headers: ['A'],
      rows: Array.from({ length: 30 }, () => ['long value']),
    });
    const services = browserServices(controller, { captureThresholdBytes: 32 });
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'table' },
      undefined,
    );
    expect(result.status).toBe('ok');
    const parsed = JSON.parse(result.modelText) as { capture_ref: string };
    expect(
      await readFile(join(runDir, 'captures', `${parsed.capture_ref}.json`), 'utf8'),
    ).toContain('long value');
  });

  // The Pi SDK compiles the same TypeBox schema and rejects the call BEFORE the
  // Yantra middleware runs, with an error that never names the accepted values.
  // Anything the tool can explain must therefore pass this gate first.
  it.each([{}, { kind: 'content' }, { kind: 'table' }, { kind: 'text' }, { kind: 'screenshot' }])(
    'accepts %o at the provider-side schema gate',
    (args) => {
      const schema = browserExtractSpec(buildServices()).parameters;
      expect(Compile(schema).Check(args)).toBe(true);
    },
  );

  it('extracts readable content when kind is omitted', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({
      title: 'Secure Area',
      text: 'Welcome to the Secure Area.',
    });
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);
    expect(result.status).toBe('ok');
    expect(controller.extract).toHaveBeenCalledWith('content');
    expect(result.modelText).toContain('Welcome to the Secure Area.');
  });

  it.each([
    ['text', 'content'],
    ['TEXT', 'content'],
    ['  readable content ', 'content'],
    ['page-content', 'content'],
    ['content', 'content'],
    ['tables', 'table'],
    ['table', 'table'],
  ])('resolves kind "%s" to the %s extraction', async (requested, expected) => {
    const controller = fakeController();
    controller.extract.mockResolvedValue(
      expected === 'content'
        ? { title: 'T', text: 'body text' }
        : { headers: ['A'], rows: [['1']] },
    );
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: requested },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(controller.extract).toHaveBeenCalledWith(expected);
  });

  it('refuses an unsupported kind with a retryable message naming the valid kinds', async () => {
    const controller = fakeController();
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'screenshot' },
      undefined,
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.retryable).toBe(true);
    expect(result.modelText).toContain('kind:\\"content\\"');
    expect(result.modelText).toContain('kind:\\"table\\"');
    // The refusal is an input decision: no extraction was attempted.
    expect(controller.extract).not.toHaveBeenCalled();
  });

  it('bounds the echoed kind in the unsupported-kind refusal', async () => {
    const controller = fakeController();
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'z'.repeat(64) },
      undefined,
    );
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toContain('z'.repeat(40));
    expect(result.modelText).not.toContain('z'.repeat(41));
  });

  it('reports an unsupported kind even when no browser is configured', async () => {
    const services = buildServices({ runDir });
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'html' },
      undefined,
    );
    expect(result.error_code).toBe('INVALID_INPUT');
  });

  it('records the resolved kind in the run trace for an aliased request', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({ title: 'T', text: 'body text' });
    controller.host.mockReturnValue('shop.example');
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });
    await wrapTool(browserExtractSpec(services), services).execute({ kind: 'text' }, undefined);
    const step = trace.steps()[0];
    expect(step?.kind).toBe('extract');
    if (step?.kind === 'extract') expect(step.extractionKind).toBe('content');
  });

  it('records the extracted page as ledger evidence so it becomes a Brief source', async () => {
    // Regression: run 20260804T043011Z-do-b85f02f1 read its hotel prices off
    // booking.com and expedia.com through the browser, but only web_search fed
    // the ledger — so the published Brief cited the search hop, not the pages
    // the answer came from.
    const controller = fakeController();
    controller.extract.mockResolvedValue({ title: 'Frisco Hotels', text: 'Motel 6 — $116 total.' });
    controller.url.mockReturnValue('https://www.expedia.com/Frisco-Hotels');
    const services = browserServices(controller);

    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'content' },
      undefined,
    );

    expect(result.status).toBe('ok');
    expect(services.evidence.entries()).toEqual([
      {
        url: 'https://www.expedia.com/Frisco-Hotels',
        finalUrl: null,
        title: 'Frisco Hotels',
        excerpt: 'Motel 6 — $116 total.',
        fetchedAt: expect.any(String),
        publishedAt: null,
        tool: 'browser_extract',
      },
    ]);
  });

  it('records one entry per page when the same page is extracted twice', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({ title: 'Frisco Hotels', text: 'Prices.' });
    const services = browserServices(controller);
    const tool = wrapTool(browserExtractSpec(services), services);

    await tool.execute({ kind: 'content' }, undefined);
    await tool.execute({ kind: 'content' }, undefined);

    expect(services.evidence.entries()).toHaveLength(1);
  });

  it('does not record a table extraction as evidence', async () => {
    // A table carries no page title or prose to excerpt; the page enters the
    // ledger when its content is read.
    const controller = fakeController();
    controller.extract.mockResolvedValue({ headers: ['Hotel'], rows: [['Motel 6']] });
    const services = browserServices(controller);

    await wrapTool(browserExtractSpec(services), services).execute({ kind: 'table' }, undefined);

    expect(services.evidence.isEmpty()).toBe(true);
  });

  it('skips evidence for a page with no fetchable URL', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({ title: '', text: 'body' });
    controller.url.mockReturnValue('about:blank');
    const services = browserServices(controller);

    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);

    expect(result.status).toBe('ok');
    expect(services.evidence.isEmpty()).toBe(true);
  });

  it('rejects a content extraction whose shape does not validate', async () => {
    const controller = fakeController();
    controller.extract.mockResolvedValue({ title: 'T' });
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'text' },
      undefined,
    );
    expect(result.error_code).toBe('EXTRACTION_SCHEMA_INVALID');
    expect(result.modelText).toContain('content');
  });

  it('prefers the engine-derived locator chain over the observed role and name', async () => {
    // The observed role/name comes from the observation scanner, whose role map
    // is a simplification of the locator engine's. When the engine can describe
    // the live element, that ranked chain is the authority — it is expressed in
    // the exact terms replay resolves, and it carries fallbacks.
    const controller = fakeController();
    controller.describeRef.mockReturnValue({ ref: 'e1', role: 'combobox', name: 'Country' });
    controller.locatorFor.mockResolvedValue([
      { kind: 'testid', value: 'country-select' },
      { kind: 'role', role: 'listbox', name: 'Country' },
      { kind: 'xpath', value: '/html[1]/body[1]/select[1]' },
    ]);
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });

    await wrapTool(browserClickSpec(services), services).execute({ ref: 'e1' }, undefined);

    const click = trace.steps()[0];
    expect(click?.kind).toBe('click');
    if (click?.kind === 'click') {
      expect(click.locator).toEqual([
        { kind: 'testid', value: 'country-select' },
        { kind: 'role', role: 'listbox', name: 'Country' },
        { kind: 'xpath', value: '/html[1]/body[1]/select[1]' },
      ]);
    }
  });

  it('records the click even when locator derivation throws', async () => {
    // A locator is a nice-to-have for the trace; it must never turn a
    // successful action into a tool failure.
    const controller = fakeController();
    controller.locatorFor.mockRejectedValue(new Error('injected runtime unavailable'));
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });

    const result = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );

    expect(result.error_code).toBeUndefined();
    expect(controller.click).toHaveBeenCalledWith('e1', { healStale: false });
    const click = trace.steps()[0];
    if (click?.kind === 'click') {
      // Degraded to the observed role/name rather than losing the step.
      expect(click.locator).toEqual([{ kind: 'role', role: 'button', name: 'Continue' }]);
    }
  });

  it('records an observation in the trace so promotion can see the run read the page', async () => {
    // An agentic run routinely ends by observing: the digest already answers
    // the question, so `browser_extract` is never called. Only extracts were
    // traced, so promotion produced a workflow that clicked through and
    // captured nothing.
    const controller = fakeController();
    controller.observe.mockResolvedValue({
      url: 'https://shop.example/status',
      title: 'Status',
      digest: 'Delivered',
      interactables: [],
    });
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });

    const result = await wrapTool(browserObserveSpec(services), services).execute({}, undefined);

    expect(result.error_code).toBeUndefined();
    expect(trace.steps()).toEqual([
      { kind: 'observe', host: 'example.com', requires_confirmation: false },
    ]);
  });

  it('does not record an observation that failed', async () => {
    const controller = fakeController();
    controller.observe.mockRejectedValue(new StaleElementRefError('e1'));
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });

    await wrapTool(browserObserveSpec(services), services).execute({}, undefined);

    expect(trace.steps()).toHaveLength(0);
  });

  it('excludes a failed interaction from the trace', async () => {
    const controller = fakeController();
    controller.click.mockRejectedValue(new StaleElementRefError('e1'));
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });
    const result = await wrapTool(browserClickSpec(services), services).execute(
      { ref: 'e1' },
      undefined,
    );
    expect(result.error_code).toBe('STALE_ELEMENT_REF');
    expect(trace.steps()).toHaveLength(0);
  });

  function browserServices(
    controller: ReturnType<typeof fakeController>,
    overrides: Partial<BrowserToolDeps> = {},
    urlProvenance: UrlProvenance = seeded('https://example.com/'),
  ): RunServices {
    return buildServices({
      runDir,
      urlProvenance,
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
          ...overrides,
        },
      },
    });
  }
});

/** A provenance record pre-loaded with URLs a tool result would have produced. */
function seeded(...urls: readonly string[]): UrlProvenance {
  const provenance = new UrlProvenance();
  for (const url of urls) provenance.record(url);
  return provenance;
}

function fakeController() {
  // Navigate and click resolve to a well-formed action result by default: the
  // real controller always returns one, and the tools now read it (to attest
  // where the page took the run), so a bare vi.fn() would be testing a shape
  // the controller cannot produce. Tests that care override it.
  const landed = { url: 'https://example.com/page', title: 'Page' };
  return {
    navigate: vi.fn().mockResolvedValue(landed),
    observe: vi.fn(),
    click: vi.fn().mockResolvedValue(landed),
    fill: vi.fn(),
    extract: vi.fn(),
    // Nothing to follow by default; the tab-follow tests supply their own.
    adoptPopup: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue('https://example.com/page'),
    host: vi.fn().mockReturnValue('example.com'),
    describeRef: vi.fn().mockReturnValue({ ref: 'e1', role: 'button', name: 'Continue' }),
    // The real controller derives the persisted locator from the live element
    // via the locator engine's ranker. Default to the degraded (empty) result
    // so tests exercise the observed-role fallback unless they opt in.
    locatorFor: vi.fn().mockResolvedValue([]),
  };
}
