import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserActionabilityError,
  EthicsRefusedError,
  FetchError,
  ReadabilityExtractor,
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
import {
  resultPublishSpec,
  createBriefPublisher,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import { webSearchSpec } from '../../../../src/adapters/pi/tools/web-search.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps, RunServices } from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import { listingHtml, multiTableHtml } from './page-fixtures.js';
import {
  assertToolContract,
  buildServices,
  searchProviderReturning,
  searchServiceFor,
} from './test-support.js';

describe('@no-llm browser tools', () => {
  it('projects continuation counts and leaves windowed reads out of the promotion trace', async () => {
    const controller = fakeController();
    const services = { ...browserServices(controller), trace: new AgentTrace() };
    controller.observe.mockResolvedValue({
      url: 'https://example.com/',
      title: 'Form',
      digest: '',
      digestUnchanged: false,
      interactables: [{ ref: 'e51', role: 'textbox', name: 'City' }],
      inventory: {
        total: 51,
        shown: 1,
        skippedBefore: 50,
        omitted: {},
        continueAfter: null,
        scanBounded: false,
      },
      window: { after: 'e50', kinds: ['field'] },
    });
    const result = await wrapTool(browserObserveSpec(services), services).execute(
      { after: 'e50', kinds: ['field'] },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(JSON.parse(result.modelText)).toMatchObject({
      inventory: { total: 51, skipped_before: 50, window: { after: 'e50', kinds: ['field'] } },
    });
    expect(result.modelText).not.toContain('digest');
    expect(controller.observe).toHaveBeenCalledWith({ window: { after: 'e50', kinds: ['field'] } });
    expect(services.trace.steps()).toHaveLength(0);
    controller.observe.mockRejectedValue(new StaleElementRefError('e50', 'continuation-cursor'));
    const stale = await wrapTool(browserObserveSpec(services), services).execute(
      { after: 'e50' },
      undefined,
    );
    expect(stale.modelText).toContain('without after');
  });
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

    it('navigates to a discovered link and names its source in the audit (FEAT-051)', async () => {
      const controller = fakeController();
      controller.navigate.mockResolvedValue({ url: 'https://shop.test/item/7', title: 'Item' });
      const provenance = new UrlProvenance();
      provenance.record('https://shop.test/item/7', {
        kind: 'discovered',
        sourceId: 'S1',
        linkKind: 'record',
      });
      const services = browserServices(controller, {}, provenance);

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://shop.test/item/7' },
        undefined,
      );

      expect(result.status).toBe('ok');
      expect((result.details as { provenance?: unknown }).provenance).toEqual({
        match: 'exact',
        kind: 'discovered',
        via: 'S1',
        link_kind: 'record',
      });
    });

    it('records the unattested refusal in the audit details', async () => {
      const controller = fakeController();
      const services = browserServices(controller, {}, seeded('https://example.com/'));

      const result = await wrapTool(browserNavigateSpec(services), services).execute(
        { url: 'https://example.com/guessed/path' },
        undefined,
      );

      expect(result.error_code).toBe('URL_NOT_FROM_EVIDENCE');
      expect(result.details).toEqual({ provenance: { match: 'none', kind: 'none' } });
      expect(result.modelText).toContain('links[] or records[]');
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

  it('reads every table from a page snapshot through the core analyzer (FEAT-051)', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(multiTableHtml()));
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'tables' },
      undefined,
    );
    expect(result.status).toBe('ok');
    const parsed = JSON.parse(result.modelText) as { tables: { index: number }[] };
    expect(parsed.tables.map((table) => table.index)).toEqual([0, 1]);
    expect(controller.extract).not.toHaveBeenCalled();
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
    setContent(controller, {
      title: 'Secure Area',
      text: 'Welcome to the Secure Area.',
    });
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);
    expect(result.status).toBe('ok');
    expect(controller.snapshot).toHaveBeenCalledOnce();
    expect(result.modelText).toContain('Welcome to the Secure Area.');
  });

  it.each([
    ['text', 'content'],
    ['TEXT', 'content'],
    ['  readable content ', 'content'],
    ['page-content', 'content'],
    ['content', 'content'],
    ['tables', 'tables'],
    ['table', 'tables'],
    ['first_table', 'tables'],
    ['listings', 'records'],
    ['items', 'records'],
    ['results', 'records'],
    ['records', 'records'],
    ['urls', 'links'],
    ['links', 'links'],
    ['json_ld', 'structured'],
    ['schema', 'structured'],
  ])('resolves kind "%s" to the %s extraction', async (requested, part) => {
    const controller = fakeController();
    setContent(controller, { title: 'T', text: 'body text' });
    controller.snapshot.mockResolvedValue(snapshotOf(listingWithTablesHtml()));
    const services = browserServices(controller);
    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: requested },
      undefined,
    );
    expect(result.status).toBe('ok');
    if (part === 'content') {
      expect(controller.snapshot).toHaveBeenCalledOnce();
      expect(controller.extract).not.toHaveBeenCalled();
    } else {
      expect(controller.snapshot).toHaveBeenCalledOnce();
      expect(JSON.parse(result.modelText)).toHaveProperty(part);
    }
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
    for (const kind of ['content', 'records', 'links', 'structured', 'tables', 'table']) {
      expect(result.modelText).toContain(`\\"${kind}\\"`);
    }
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
    setContent(controller, { title: 'T', text: 'body text' });
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
    setContent(controller, { title: 'Frisco Hotels', text: 'Motel 6 — $116 total.' });
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
        sourceId: 'S1',
      },
    ]);
  });

  it('records one entry per page when the same page is extracted twice', async () => {
    const controller = fakeController();
    setContent(controller, { title: 'Frisco Hotels', text: 'Prices.' });
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
    setContent(controller, { title: '', text: 'body' });
    controller.url.mockReturnValue('about:blank');
    const services = browserServices(controller);

    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);

    expect(result.status).toBe('ok');
    expect(services.evidence.isEmpty()).toBe(true);
  });

  it('gives a content extraction the page’s evidence ID, and the same ID on a second extract', async () => {
    const controller = fakeController();
    setContent(controller, { title: 'Listing', text: 'Live prices.' });
    const services = browserServices(controller);
    const tool = wrapTool(browserExtractSpec(services), services);

    const first = JSON.parse((await tool.execute({ kind: 'content' }, undefined)).modelText);
    const second = JSON.parse((await tool.execute({ kind: 'content' }, undefined)).modelText);

    expect(first).toMatchObject({ source_id: 'S1', text: 'Live prices.' });
    // The live page may have changed, so a repeat extract still returns content.
    expect(second).toMatchObject({ source_id: 'S1', text: 'Live prices.' });
    expect(second).not.toHaveProperty('already_read');
    expect(services.documents.stats()).toMatchObject({ networkLoads: 0, observed: 1 });
    expect(services.evidence.entries()[0]?.sourceId).toBe('S1');
  });

  it('reuses the ID web_fetch minted for the same page', async () => {
    const controller = fakeController();
    setContent(controller, { title: 'Page', text: 'Body.' });
    const services = browserServices(controller);
    await services.documents.read('https://example.com/page', () =>
      Promise.resolve({
        ok: true,
        value: null,
        meta: {
          url: 'https://example.com/page',
          finalUrl: null,
          title: 'Page',
          fetchMode: 'http',
          tool: 'web_fetch',
        },
      }),
    );
    await services.documents.read('https://example.com/other', () =>
      Promise.resolve({
        ok: true,
        value: null,
        meta: {
          url: 'https://example.com/other',
          finalUrl: null,
          title: null,
          fetchMode: 'http',
          tool: 'web_fetch',
        },
      }),
    );
    controller.url.mockReturnValue('https://example.com/other/');

    const result = await wrapTool(browserExtractSpec(services), services).execute(
      { kind: 'content' },
      undefined,
    );

    expect(JSON.parse(result.modelText)).toMatchObject({ source_id: 'S2' });
    expect(services.documents.stats().observed).toBe(0);
  });

  it('records a table read as evidence with an ID (FEAT-051 supersedes the FEAT-050 table rule)', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(multiTableHtml()));
    const services = browserServices(controller);

    const result = JSON.parse(
      (await wrapTool(browserExtractSpec(services), services).execute({ kind: 'table' }, undefined))
        .modelText,
    ) as { source_id?: string; tables?: unknown[] };

    expect(result.source_id).toBe('S1');
    expect(result.tables).toHaveLength(1);
    expect(services.evidence.entries().map((entry) => entry.sourceId)).toEqual(['S1']);
  });

  it('mints no ID and no ledger entry for about:blank', async () => {
    const controller = fakeController();
    setContent(controller, { title: '', text: 'body' });
    controller.url.mockReturnValue('about:blank');
    const services = browserServices(controller);

    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);

    expect(JSON.parse(result.modelText)).not.toHaveProperty('source_id');
    expect(services.documents.entries()).toEqual([]);
  });

  it('carries the budget meter on an extract result', async () => {
    const controller = fakeController();
    setContent(controller, { title: 'T', text: 'x' });
    const services = browserServices(controller);

    const result = await wrapTool(browserExtractSpec(services), services).execute({}, undefined);

    expect(JSON.parse(result.modelText)).toMatchObject({
      budget: { navigations: '0/30', hosts: '0/20' },
    });
  });

  it('rejects a content extraction whose shape does not validate', async () => {
    const controller = fakeController();
    setContent(controller, { title: 'T' });
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
      fetch: { extractor: new ReadabilityExtractor() },
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
  for (const url of urls) provenance.record(url, { kind: 'tool', tool: 'test' });
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
    snapshot: vi.fn().mockResolvedValue(snapshotOf('<html><body><p>Page.</p></body></html>')),
    // Nothing to follow by default; the tab-follow tests supply their own.
    adoptPopup: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue('https://example.com/page'),
    host: vi.fn().mockReturnValue('example.com'),
    describeRef: vi.fn().mockReturnValue({ ref: 'e1', role: 'button', name: 'Continue' }),
    // Unreadable facts classify by name alone (FEAT-054 reads this before every click).
    submitFacts: vi.fn().mockResolvedValue(null),
    // The real controller derives the persisted locator from the live element
    // via the locator engine's ranker. Default to the degraded (empty) result
    // so tests exercise the observed-role fallback unless they opt in.
    locatorFor: vi.fn().mockResolvedValue([]),
    // The middleware opens every top-level tool call; the real controller
    // resets its one obstruction clearance here.
    beginToolCall: vi.fn(),
  };
}

/** A page snapshot as the controller would serialize it. */
function snapshotOf(html: string, url = 'https://example.com/page') {
  return { url, title: 'Page', html, visibleText: '', truncated: false };
}

/** A listing whose page also holds a table and schema.org data, so every kind has a part. */
function listingWithTablesHtml(): string {
  return listingHtml().replace(
    '</main>',
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>' +
      '<script type="application/ld+json">{"@type":"Product","name":"P","url":"https://example.com/p"}</script></main>',
  );
}

describe('@no-llm browser_extract — shape-aware kinds (FEAT-051)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-extract-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function services(
    controller: ReturnType<typeof fakeController>,
    trace?: AgentTrace,
  ): RunServices {
    return buildServices({
      runDir,
      urlProvenance: seeded('https://example.com/'),
      ...(trace === undefined ? {} : { trace }),
      fetch: { extractor: new ReadabilityExtractor() },
      domain: {
        browser: {
          controller: controller as unknown as AgentBrowserController,
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 16 * 1024,
        },
      },
    });
  }

  async function extract(
    run: RunServices,
    params: Record<string, unknown>,
  ): Promise<{
    status: string;
    error_code?: string;
    model: Record<string, unknown>;
    details: unknown;
  }> {
    const result = await wrapTool(browserExtractSpec(run), run).execute(params, undefined);
    return {
      status: result.status,
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      model: JSON.parse(result.modelText) as Record<string, unknown>,
      details: result.details,
    };
  }

  it('returns anchored records from a listing and records the page as evidence', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(listingHtml()));
    const run = services(controller);

    const { model } = await extract(run, { kind: 'records' });

    expect((model.records as { id: string }[]).map((record) => record.id)).toEqual([
      'S1#r1',
      'S1#r2',
      'S1#r3',
      'S1#r4',
      'S1#r5',
      'S1#r6',
    ]);
    expect(model.links).toBeUndefined();
    expect(run.evidence.entries()).toHaveLength(1);
  });

  it('returns one table by index, and refuses an index past the last table', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(multiTableHtml()));
    const run = services(controller);

    const second = await extract(run, { kind: 'table', index: 1 });
    const missing = await extract(run, { kind: 'table', index: 5 });

    const [table] = second.model.tables as { index: number; rows: string[][] }[];
    expect(table?.index).toBe(1);
    expect(table?.rows).toContainEqual(['Summit', 'AWD', '4,500 lb']);
    expect(missing.error_code).toBe('INVALID_INPUT');
    expect(missing.details).toEqual({ count: 2 });
    expect(JSON.stringify(missing.model)).toContain('The page has 2 tables (index 0 to 1)');
  });

  it('says a page has no tables when asked for one', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(
      snapshotOf('<html><body><p>No tables.</p></body></html>'),
    );
    const missing = await extract(services(controller), { kind: 'table', index: 0 });
    expect(JSON.stringify(missing.model)).toContain('has no tables');
  });

  it('returns structured entities', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(listingWithTablesHtml()));
    const { model } = await extract(services(controller), { kind: 'structured' });
    expect(model.structured).toEqual([
      { type: 'Product', from: 'json-ld', props: { name: 'P', url: 'https://example.com/p' } },
    ]);
  });

  it('returns links with record links included, attests them, and records no evidence', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(
      snapshotOf(listingHtml(), 'https://example.com/new/results'),
    );
    const run = services(controller);

    const { model } = await extract(run, { kind: 'links' });
    const links = model.links as { kind: string; url: string }[];

    expect(links.filter((link) => link.kind === 'record')).toHaveLength(6);
    expect(links[0]?.kind).toBe('pagination');
    expect(run.evidence.isEmpty()).toBe(true);
    expect(run.urlProvenance.explain('https://example.com/vehicle/itm-01')?.origin).toEqual({
      kind: 'discovered',
      sourceId: 'S1',
      linkKind: 'record',
    });
  });

  it.each(['content', 'records', 'links', 'structured', 'tables', 'table'])(
    'refuses a %s challenge read across tools with one audit notice and no evidence',
    async (kind) => {
      const controller = fakeController();
      controller.snapshot.mockResolvedValue(
        snapshotOf(
          '<html><head><title>Verify you are human</title></head><body><form>' +
            '<div class="g-recaptcha" data-sitekey="k"></div><a href="/next">next</a></form></body></html>',
          'https://example.com/walled',
        ),
      );
      const run = services(controller);

      run.urlProvenance.record('https://example.com/walled', { kind: 'goal' });
      const result = await extract(run, { kind });
      controller.url.mockReturnValue('https://example.com/walled');
      for (const tool of [
        wrapTool(browserExtractSpec(run), run),
        wrapTool(webFetchSpec(run), run),
        wrapTool(browserNavigateSpec(run), run),
      ]) {
        const next = await tool.execute(
          tool.name === 'browser_extract' ? { kind } : { url: controller.url() },
          undefined,
        );
        expect(next.error_code).toBe('SITE_CHALLENGE');
        expect(next.details).toMatchObject({ already_attempted: true });
      }
      expect(controller.snapshot).toHaveBeenCalledOnce();
      expect(controller.navigate).not.toHaveBeenCalled();
      expect(run.budgets.snapshot().navigations).toBe(0);
      expect(run.runHealth.briefFacts().notices).toEqual([
        expect.objectContaining({ kind: 'blocked', source: 'example.com' }),
      ]);

      expect(result.error_code).toBe('SITE_CHALLENGE');
      expect(result.details).toMatchObject({ handoff: true, tier: 'browser' });
      expect(run.evidence.isEmpty()).toBe(true);
      expect(run.urlProvenance.has('https://example.com/next')).toBe(false);
      expect(run.documents.entries()).toEqual([]);

      const searching = {
        ...run,
        domain: {
          ...run.domain,
          search: {
            ...run.domain.search,
            service: searchServiceFor(
              searchProviderReturning([
                {
                  url: controller.url(),
                  rank: 1,
                  title: 'Inventory',
                  snippet: '',
                  source: 'duckduckgo',
                  publishedAt: null,
                },
              ]),
            ),
          },
        },
      };
      const searched = await wrapTool(webSearchSpec(searching), searching).execute(
        { query: 'inventory', limit: 1 },
        undefined,
      );
      expect(searched.modelText).toContain('challenge page');
      expect(run.documents.stats().networkLoads).toBe(0);
    },
  );

  it('refuses browser reads and navigation after a fetch observed a browser challenge', async () => {
    const controller = fakeController();
    const run = services(controller);
    const url = 'https://example.com/page';
    run.urlProvenance.record(url, { kind: 'goal' });
    const fetcher = vi.fn(() =>
      Promise.reject(
        new FetchError('Browser challenge', {
          url,
          kind: 'challenge',
          tier: 'browser',
          marker: 'g-recaptcha',
        }),
      ),
    );
    const fetching = {
      ...run,
      domain: { ...run.domain, fetch: { ...run.domain.fetch, fetcher: { fetch: fetcher } } },
    };
    expect(
      (await wrapTool(webFetchSpec(fetching), fetching).execute({ url }, undefined)).error_code,
    ).toBe('SITE_CHALLENGE');
    for (const tool of [
      wrapTool(browserExtractSpec(run), run),
      wrapTool(browserNavigateSpec(run), run),
    ]) {
      const result = await tool.execute(
        tool.name === 'browser_extract' ? { kind: 'content' } : { url },
        undefined,
      );
      expect(result.error_code).toBe('SITE_CHALLENGE');
      expect(result.details).toMatchObject({ already_attempted: true });
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(controller.snapshot).not.toHaveBeenCalled();
    expect(controller.navigate).not.toHaveBeenCalled();
  });

  it('serves both stored tables after extracting only the first one', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(multiTableHtml()));
    const run = services(controller);
    await extract(run, { kind: 'table', index: 0 });
    const result = await wrapTool(webFetchSpec(run), run).execute(
      { url: 'https://example.com/page' },
      undefined,
    );
    const payload = JSON.parse(result.modelText) as { tables: unknown[] };
    expect(payload.tables).toHaveLength(2);
    expect(run.documents.stats().networkLoads).toBe(0);
  });

  it('serves and cites a full stored page after a links-only browser read without a fetch', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(listingHtml()));
    const run = services(controller);
    await extract(run, { kind: 'links' });
    expect(run.documents.get('S1')?.page?.delivered).toBe('partial');
    const fetched = await wrapTool(webFetchSpec(run), run).execute(
      { url: 'https://example.com/page' },
      undefined,
    );
    const model = JSON.parse(fetched.modelText) as { source_id: string; records: { id: string }[] };
    expect(model.records).toHaveLength(6);
    expect(run.evidence.entries()[0]?.sourceId).toBe('S1');
    expect(run.documents.stats().networkLoads).toBe(0);
    const publishing = { ...run, domain: { ...run.domain, publish: createBriefPublisher(runDir) } };
    const published = await wrapTool(resultPublishSpec(publishing), publishing).execute(
      {
        brief: {
          title: 'Inventory',
          overview: '',
          table: { columns: ['Price'], rows: [[50000]], row_sources: [[model.records[0]!.id]] },
        },
      },
      undefined,
    );
    expect(published.status).toBe('ok');
  });

  it('retains rendered content beyond the ledger excerpt for citation anchoring', async () => {
    const controller = fakeController();
    setContent(controller, {
      title: 'Inventory',
      text: 'Introduction. '.repeat(90) + 'Price 45000',
    });
    const run = services(controller);
    await extract(run, { kind: 'content' });
    const publishing = { ...run, domain: { ...run.domain, publish: createBriefPublisher(runDir) } };
    const result = await wrapTool(resultPublishSpec(publishing), publishing).execute(
      {
        brief: {
          title: 'Offer',
          overview: '',
          table: { columns: ['Price'], rows: [[45000]], row_sources: [['S1']] },
        },
      },
      undefined,
    );
    expect(result.status).toBe('ok');
    const brief: unknown = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    expect(brief).toMatchObject({ metadata: { citation_verdict: { flagged: 0 } } });
  });

  it('keeps record anchors stable when a card is inserted at the top', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(listingHtml()));
    const run = services(controller);
    const first = (await extract(run, { kind: 'records' })).model.records as {
      id: string;
      url: string;
    }[];

    const inserted = listingHtml().replace(
      '<ol>',
      '<ol><li><h3><a href="/vehicle/itm-99">New 2026 Teyra Summit 99</a></h3>' +
        '<p><a href="/dealer/9">Late Arrival Motors</a></p><p>1.0 mi away</p></li>',
    );
    controller.snapshot.mockResolvedValue(snapshotOf(inserted));
    const second = (await extract(run, { kind: 'records' })).model.records as {
      id: string;
      url: string;
    }[];

    const idOf = (records: { id: string; url: string }[], url: string): string | undefined =>
      records.find((record) => record.url === url)?.id;
    for (const record of first) expect(idOf(second, record.url)).toBe(record.id);
    expect(idOf(second, 'https://example.com/vehicle/itm-99')).toBe('S1#r7');
  });

  it('reads the same records as web_fetch from the same HTML (one grammar)', async () => {
    const controller = fakeController();
    const url = 'https://example.com/new/results';
    controller.snapshot.mockResolvedValue(snapshotOf(listingHtml(), url));
    const live = (await extract(services(controller), { kind: 'records' })).model.records;

    const fetchRun = buildServices({
      runDir,
      urlProvenance: seeded(url),
      fetch: {
        fetcher: {
          fetch: () =>
            Promise.resolve({
              url,
              finalUrl: url,
              fetchedAt: 'x',
              contentType: 'text/html',
              html: listingHtml(),
              statusCode: 200,
              fetchMode: 'browser' as const,
              elapsedMs: 0,
            }),
        },
        extractor: new ReadabilityExtractor(),
      },
    });
    const fetched = JSON.parse(
      (await wrapTool(webFetchSpec(fetchRun), fetchRun).execute({ url }, undefined)).modelText,
    ) as { records: unknown };

    expect(live).toEqual(fetched.records);
  });

  it('records the replayable read in the trace: only table index 0 promotes as a table', async () => {
    const controller = fakeController();
    controller.snapshot.mockResolvedValue(snapshotOf(multiTableHtml()));
    const trace = new AgentTrace();
    const run = services(controller, trace);

    await extract(run, { kind: 'table', index: 0 });
    await extract(run, { kind: 'table', index: 1 });
    await extract(run, { kind: 'records' });

    expect(
      trace.steps().map((step) => (step.kind === 'extract' ? step.extractionKind : step.kind)),
    ).toEqual(['table', 'content', 'content']);
  });
});

/** Supply one live snapshot, preserving the browser's rendered-text seam. */
function setContent(
  controller: ReturnType<typeof fakeController>,
  content: { title: string; text?: string },
): void {
  controller.snapshot.mockImplementation(async () => ({
    ...snapshotOf('<html><body><main><p>Visible body.</p></main></body></html>', controller.url()),
    title: content.title,
    visibleText: content.text,
  }));
}
