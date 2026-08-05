import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  StaleElementRefError,
  UserInputVault,
  type AgentBrowserController,
  type OpaqueRefResolver,
} from '@yantra/core';
import type { ConfirmationGateway, ConfirmationOutcome } from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { Compile } from 'typebox/compile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { browserExtractSpec } from '../../../../src/adapters/pi/tools/browser-extract.js';
import { browserFillSpec } from '../../../../src/adapters/pi/tools/browser-fill.js';
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
    await assertToolContract(browserFillSpec(services), { ref: 'e1', value: 42 });
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

  it('checks secret host binding before resolution and never echoes a canary', async () => {
    const controller = fakeController();
    controller.host.mockReturnValue('evil.example');
    const resolver = fakeSecretResolver('CANARY-super-secret');
    const services = withGrant(
      browserServices(controller, {
        secretResolver: resolver,
        secretHosts: () => Promise.resolve(['safe.example']),
      }),
    );
    const mismatch = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: { kind: 'secret_ref', key: 'site.password' } },
      undefined,
    );
    expect(mismatch.error_code).toBe('SECRET_HOST_MISMATCH');
    expect(resolver.resolve).not.toHaveBeenCalled();

    controller.host.mockReturnValue('login.safe.example');
    const filled = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: { kind: 'secret_ref', key: 'site.password' } },
      undefined,
    );
    expect(filled.status).toBe('ok');
    expect(JSON.stringify(filled)).not.toContain('CANARY-super-secret');
  });

  it('rejects credential-shaped literals', async () => {
    const controller = fakeController();
    const services = browserServices(controller);
    const result = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: { kind: 'literal', value: 'sk-ABCDEFGHIJKLMNOPQRSTUV' } },
      undefined,
    );
    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(controller.fill).not.toHaveBeenCalled();
  });

  it('accepts a bare string value as a non-secret literal', async () => {
    // Regression: the discriminated-union-only schema rejected the plain-string
    // form small models emit ("value must be object"), so they looped on an
    // impossible retry. A bare string must now fill the field as a literal.
    const controller = fakeController();
    controller.fill.mockResolvedValue({ url: 'https://example.com', title: 'Page' });
    const services = browserServices(controller);
    const result = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: 'tomsmith' },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(controller.fill).toHaveBeenCalledWith('e1', 'tomsmith');
  });

  it('rejects a credential-shaped bare string just like an object literal', async () => {
    const controller = fakeController();
    const services = browserServices(controller);
    const result = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: 'sk-ABCDEFGHIJKLMNOPQRSTUV' },
      undefined,
    );
    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(controller.fill).not.toHaveBeenCalled();
  });

  it('records a bare-string fill as a non-confirmation literal in the trace', async () => {
    const controller = fakeController();
    controller.fill.mockResolvedValue({ url: 'https://shop.example/login', title: 'Login' });
    controller.host.mockReturnValue('shop.example');
    controller.describeRef.mockReturnValue({ ref: 'e1', role: 'textbox', name: 'Username' });
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
    await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: 'tomsmith' },
      undefined,
    );
    const step = trace.steps()[0];
    expect(step?.kind).toBe('fill');
    if (step?.kind === 'fill') {
      expect(step.value).toEqual({ kind: 'literal', value: 'tomsmith' });
      expect(step.requires_confirmation).toBe(false);
    }
  });

  it('fills the REAL user value when the model passes a vault placeholder', async () => {
    // Regression: the goal sanitizer produced irreversible '[redacted-email]'
    // markers, so the model could only type the marker into the field — the
    // fill "succeeded" with junk. The vault placeholder must resolve to the
    // real user-provided value at the execution boundary, while the model-visible
    // result and the persisted trace keep only the placeholder.
    const controller = fakeController();
    controller.fill.mockResolvedValue({ url: 'https://shop.example/signup', title: 'Signup' });
    controller.host.mockReturnValue('shop.example');
    controller.describeRef.mockReturnValue({ ref: 'e1', role: 'textbox', name: 'Email' });
    const vault = new UserInputVault();
    expect(vault.redact('sign up with john@example.com')).toContain('{{user:email:1}}');
    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      userInput: vault,
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

    const result = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: '{{user:email:1}}' },
      undefined,
    );

    expect(result.status).toBe('ok');
    expect(controller.fill).toHaveBeenCalledWith('e1', 'john@example.com');
    expect(JSON.stringify(result)).not.toContain('john@example.com');
    const step = trace.steps()[0];
    expect(step?.kind).toBe('fill');
    if (step?.kind === 'fill') {
      expect(step.value).toEqual({ kind: 'literal', value: '{{user:email:1}}' });
    }
  });

  it('still rejects a credential-shaped user value resolved from a placeholder', async () => {
    // The vault must not become a bypass around the credential-literal guard:
    // an API-key-shaped value in the goal resolves at the boundary and is then
    // rejected exactly like a raw credential literal, without echoing it.
    const controller = fakeController();
    const vault = new UserInputVault();
    const redacted = vault.redact('use key sk-ABCDEFGHIJKLMNOPQRSTUV');
    expect(redacted).toContain('{{user:api_key:1}}');
    const services = buildServices({
      runDir,
      userInput: vault,
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

    const result = await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: '{{user:api_key:1}}' },
      undefined,
    );

    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(controller.fill).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
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

  it('records successful navigate/fill/click into the run trace with candidate chains', async () => {
    const controller = fakeController();
    controller.navigate.mockResolvedValue({ url: 'https://shop.example/login', title: 'Login' });
    controller.fill.mockResolvedValue({ url: 'https://shop.example/login', title: 'Login' });
    controller.click.mockResolvedValue({ url: 'https://shop.example/home', title: 'Home' });
    controller.host.mockReturnValue('shop.example');
    controller.describeRef.mockReturnValue({ ref: 'e1', role: 'textbox', name: 'Email' });

    const trace = new AgentTrace();
    const services = buildServices({
      runDir,
      trace,
      urlProvenance: seeded('https://shop.example/login'),
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

    await wrapTool(browserNavigateSpec(services), services).execute(
      { url: 'https://shop.example/login' },
      undefined,
    );
    await wrapTool(browserFillSpec(services), services).execute(
      { ref: 'e1', value: { kind: 'literal', value: 'ada@example.com' } },
      undefined,
    );
    controller.describeRef.mockReturnValue({ ref: 'e2', role: 'button', name: 'Continue' });
    await wrapTool(browserClickSpec(services), services).execute({ ref: 'e2' }, undefined);

    const steps = trace.steps();
    expect(steps.map((s) => s.kind)).toEqual(['navigate', 'fill', 'click']);
    const fill = steps[1];
    const click = steps[2];
    if (fill?.kind === 'fill') {
      expect(fill.locator).toEqual([{ kind: 'role', role: 'textbox', name: 'Email' }]);
      expect(fill.value).toEqual({ kind: 'literal', value: 'ada@example.com' });
    }
    if (click?.kind === 'click') {
      expect(click.locator).toEqual([{ kind: 'role', role: 'button', name: 'Continue' }]);
    }
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
    expect(controller.click).toHaveBeenCalledWith('e1');
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
  return {
    navigate: vi.fn(),
    observe: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    extract: vi.fn(),
    url: vi.fn().mockReturnValue('https://example.com/page'),
    host: vi.fn().mockReturnValue('example.com'),
    describeRef: vi.fn().mockReturnValue({ ref: 'e1', role: 'button', name: 'Continue' }),
    // The real controller derives the persisted locator from the live element
    // via the locator engine's ranker. Default to the degraded (empty) result
    // so tests exercise the observed-role fallback unless they opt in.
    locatorFor: vi.fn().mockResolvedValue([]),
  };
}

function fakeSecretResolver(
  value: string,
): OpaqueRefResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn().mockResolvedValue({
      value,
      isSecret: true,
      source: 'secret',
      sourceKey: 'site.password',
      dispose: vi.fn(),
    }),
  };
}

function withGrant(services: RunServices): RunServices {
  const gateway: ConfirmationGateway = {
    request: (request: ConfirmationRequest): Promise<ConfirmationOutcome> =>
      Promise.resolve({
        confirmation_id: request.confirmation_id,
        decision: 'granted',
        decided_at: new Date().toISOString(),
        decided_by: 'user_interactive',
      }),
  };
  return { ...services, confirmation: { gateway, store: null } };
}
