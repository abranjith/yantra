import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  StaleElementRefError,
  type AgentBrowserController,
  type OpaqueRefResolver,
} from '@yantra/core';
import type { ConfirmationGateway, ConfirmationOutcome } from '@yantra/core';
import type { ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { browserExtractSpec } from '../../../../src/adapters/pi/tools/browser-extract.js';
import { browserFillSpec } from '../../../../src/adapters/pi/tools/browser-fill.js';
import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import { browserObserveSpec } from '../../../../src/adapters/pi/tools/browser-observe.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps, RunServices } from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';

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
    await assertToolContract(browserExtractSpec(services), { kind: 'html' });
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
  ): RunServices {
    return buildServices({
      runDir,
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

function fakeController() {
  return {
    navigate: vi.fn(),
    observe: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    extract: vi.fn(),
    host: vi.fn().mockReturnValue('example.com'),
    describeRef: vi.fn().mockReturnValue({ ref: 'e1', role: 'button', name: 'Continue' }),
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
