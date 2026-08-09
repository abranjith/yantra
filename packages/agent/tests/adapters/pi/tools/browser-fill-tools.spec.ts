/// <reference lib="dom" />

import { globSync, readFileSync } from 'node:fs';

import {
  type AgentBrowserController,
  type AgentBrowserObservation,
  type AgentInteractable,
  type OpaqueRefResolver,
  UserInputVault,
} from '@yantra/core';
import type { ConfirmationGateway } from '@yantra/core';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { browserFillElementSpec } from '../../../../src/adapters/pi/tools/browser-fill-element.js';
import { browserFillFormSpec } from '../../../../src/adapters/pi/tools/browser-fill-form.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps } from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';

import { allowingEthics, buildServices } from './test-support.js';

describe('@no-llm browser_fill_form engine delegation', () => {
  it('applies text, typeahead, and a date range through the expected paths', async () => {
    const controller = formController();
    const trace = new AgentTrace();

    const result = await run(
      controller,
      {
        fields: [
          { field: 'Search', value: 'stadium hotels' },
          { field: 'Where to?', value: 'Frisco, Texas' },
          { field: 'Dates', value: '2026-09-06..2026-09-08' },
        ],
      },
      trace,
    );
    const model = JSON.parse(result.modelText) as {
      readonly applied: readonly Record<string, unknown>[];
    };

    expect(result.status).toBe('ok');
    expect(model.applied).toEqual([
      expect.objectContaining({
        field: 'Search',
        driver: 'plain-text',
        committed: 'stadium hotels',
      }),
      expect.objectContaining({
        field: 'Where to?',
        driver: 'typeahead',
        committed: 'Frisco Texas, United States',
      }),
      expect.objectContaining({
        field: 'Dates',
        driver: 'calendar-grid',
        committed: 'Sep 6, 2026 - Sep 8, 2026',
      }),
    ]);
    expect(trace.steps().map((step) => step.kind)).toEqual([
      'fill_element',
      'fill_element',
      'fill_element',
    ]);
  });

  it('preserves field ordering and stops at the first failure', async () => {
    const controller = new FormController(
      '<input id="first" aria-label="First"><button id="toggle" aria-label="Toggle">Toggle</button>' +
        '<input id="last" aria-label="Last">',
    );

    const result = await run(controller, {
      fields: [
        { field: 'First', value: 'one' },
        { field: 'Toggle', value: 'two' },
        { field: 'Last', value: 'three' },
      ],
    });
    expect(result.error_code).toBe('WIDGET_TARGET_UNREACHABLE');
    expect(
      (result.details as { readonly applied: readonly Record<string, unknown>[] }).applied,
    ).toEqual([expect.objectContaining({ field: 'First', committed: 'one' })]);
    expect(controller.document.querySelector<HTMLInputElement>('#last')!.value).toBe('');
  });

  it('does not toggle an already-open calendar shut', async () => {
    const controller = formController();

    const result = await run(controller, {
      fields: [{ field: 'Dates', value: '2026-09-06' }],
    });

    expect(result.status).toBe('ok');
    expect(controller.clickLog).toEqual(['6']);
  });

  it('keeps retired widget error codes and helpers out of agent source', () => {
    const sourceRoot = new URL('../../../../src/', import.meta.url);
    const source = globSync('**/*.ts', { cwd: sourceRoot })
      .map((file) => readFileSync(new URL(file.replaceAll('\\', '/'), sourceRoot), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/FORM_WIDGET_NO_MATCH|SUGGESTION_NOT_OFFERED/);
    expect(source).not.toMatch(/\bchooseInWidget\b|\bpickSuggestion\b/);
  });

  it('fills plain text through the unified engine without clicking', async () => {
    const controller = new FormController('<input id="search" aria-label="Search">');

    const result = await run(controller, {
      fields: [{ field: 'Search', value: 'hello' }],
    });

    expect(result.status).toBe('ok');
    expect(controller.clickLog).toEqual([]);
  });

  it('refuses a credential-shaped value before partially filling the form', async () => {
    const controller = new FormController(
      '<input id="first" aria-label="First"><input id="second" aria-label="Second">',
    );

    const result = await run(controller, {
      fields: [
        { field: 'First', value: 'safe' },
        { field: 'Second', value: 'sk-abcdefghijklmnopqrstuvwxyz' },
      ],
    });

    expect(result.error_code).toBe('FILL_VALUE_INVALID');
    expect(controller.observationCount).toBe(0);
    expect(controller.document.querySelector<HTMLInputElement>('#first')!.value).toBe('');
  });

  it('keeps secret refs outside the multi-field form schema', async () => {
    const controller = new FormController('<input id="password" aria-label="Password">');

    const result = await run(controller, {
      fields: [{ field: 'Password', value: { kind: 'secret_ref', key: 'site.password' } }],
    });

    expect(result.error_code).toBe('INVALID_INPUT');
    expect(controller.observationCount).toBe(0);
  });
});

describe('@no-llm browser_fill_element contract', () => {
  it('resolves a field name, emits one semantic trace step, and takes one post-action read', async () => {
    const controller = new FormController('<input id="search" aria-label="Search">');
    const trace = new AgentTrace();
    const { result } = await runElement(
      controller,
      { field: 'Search', value: 'quiet room' },
      trace,
    );
    const model = JSON.parse(result.modelText) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(model).toMatchObject({
      committed: 'quiet room',
      driver: 'plain-text',
      dismissed: false,
      observation: { title: 'Form' },
    });
    expect(controller.observationCount).toBe(2);
    expect(trace.steps()).toEqual([
      expect.objectContaining({
        kind: 'fill_element',
        field: { role: 'textbox', name: 'Search', group: null },
        value: { kind: 'literal', value: 'quiet room' },
      }),
    ]);
  });

  it('rejects malformed dates and credential-shaped literals before page mutation', async () => {
    const invalidDate = new FormController('<input id="date" aria-label="Date">');
    const malformed = await runElement(invalidDate, { field: 'Date', value: '2026-13-40' });
    expect(malformed.result.error_code).toBe('FILL_VALUE_INVALID');
    expect(invalidDate.document.querySelector<HTMLInputElement>('#date')!.value).toBe('');

    const credential = new FormController('<input id="token" aria-label="Token">');
    const secretLiteral = await runElement(credential, {
      field: 'Token',
      value: `sk-${'a'.repeat(20)}`,
    });
    expect(secretLiteral.result.error_code).toBe('FILL_VALUE_INVALID');
    expect(credential.document.querySelector<HTMLInputElement>('#token')!.value).toBe('');
  });

  it('accepts the explicit tagged-literal shape', async () => {
    const controller = new FormController('<input id="search" aria-label="Search">');

    const { result } = await runElement(controller, {
      field: 'Search',
      value: { kind: 'literal', value: 'quiet room' },
    });

    expect(result.status).toBe('ok');
    expect(controller.document.querySelector<HTMLInputElement>('#search')!.value).toBe(
      'quiet room',
    );
  });

  it('checks secret host binding before resolving the secret', async () => {
    const controller = new FormController(
      '<input id="password" type="password" aria-label="Password">',
    );
    const resolver: OpaqueRefResolver = {
      resolve: vi.fn().mockRejectedValue(new Error('must not resolve')),
    };

    const { result } = await runElement(
      controller,
      { field: 'Password', value: { kind: 'secret_ref', key: 'site.password' } },
      new AgentTrace(),
      { secretResolver: resolver, secretHosts: () => Promise.resolve(['safe.example']) },
      true,
    );

    expect(result.error_code).toBe('SECRET_HOST_MISMATCH');
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('host-binds secret refs, omits committed text, and never leaks the resolved canary', async () => {
    const controller = new FormController(
      '<input id="password" type="password" aria-label="Password">',
    );
    const dispose = vi.fn();
    const resolver: OpaqueRefResolver = {
      resolve: vi.fn().mockResolvedValue({
        value: 'CANARY-super-secret',
        isSecret: true,
        source: 'secret',
        sourceKey: 'site.password',
        dispose,
      }),
    };
    const trace = new AgentTrace();
    const { result } = await runElement(
      controller,
      { field: 'Password', value: { kind: 'secret_ref', key: 'site.password' } },
      trace,
      { secretResolver: resolver, secretHosts: () => Promise.resolve(['example.test']) },
      true,
    );
    const model = JSON.parse(result.modelText) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(model).not.toHaveProperty('committed');
    expect(JSON.stringify(result)).not.toContain('CANARY-super-secret');
    expect(dispose).toHaveBeenCalledOnce();
    expect(trace.steps()).toEqual([
      expect.objectContaining({
        kind: 'fill_element',
        value: { kind: 'secret_ref', key: 'site.password' },
        requires_confirmation: true,
      }),
    ]);
  });

  it('resolves user placeholders at the boundary and masks the result and trace', async () => {
    const controller = new FormController('<input id="email" aria-label="Email">');
    const vault = new UserInputVault();
    expect(vault.redact('sign up with john@example.com')).toContain('{{user:email:1}}');
    const trace = new AgentTrace();

    const { result } = await runElement(
      controller,
      { field: 'Email', value: '{{user:email:1}}' },
      trace,
      {},
      false,
      vault,
    );

    expect(result.status).toBe('ok');
    expect(controller.document.querySelector<HTMLInputElement>('#email')!.value).toBe(
      'john@example.com',
    );
    expect(JSON.stringify(result)).not.toContain('john@example.com');
    expect(trace.steps()).toEqual([
      expect.objectContaining({
        kind: 'fill_element',
        value: { kind: 'literal', value: '{{user:email:1}}' },
      }),
    ]);
  });

  it('does not let a resolved user placeholder bypass the credential guard', async () => {
    const controller = new FormController('<input id="token" aria-label="Token">');
    const vault = new UserInputVault();
    expect(vault.redact('use sk-ABCDEFGHIJKLMNOPQRSTUV')).toContain('{{user:api_key:1}}');

    const { result } = await runElement(
      controller,
      { field: 'Token', value: '{{user:api_key:1}}' },
      new AgentTrace(),
      {},
      false,
      vault,
    );

    expect(result.error_code).toBe('FILL_VALUE_INVALID');
    expect(controller.document.querySelector<HTMLInputElement>('#token')!.value).toBe('');
    expect(JSON.stringify(result)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUV');
  });

  it('dismisses the failed field widget before form processing stops', async () => {
    // A control that cannot hold typed text, so an unresolvable choice really
    // is a failure. On an editable combobox the same tie now commits the typed
    // literal instead, which is covered in the core engine suite.
    const controller = new FormController(
      '<div id="city" role="combobox" aria-label="City" aria-controls="choices" aria-expanded="true"></div>' +
        '<div id="choices" role="listbox"><button role="option">New York, NY</button><button role="option">New York, USA</button></div>',
    );
    const popup = controller.document.querySelector<HTMLElement>('#choices')!;
    controller.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') popup.style.display = 'none';
    });

    const result = await run(controller, {
      fields: [{ field: 'City', value: 'New York' }],
    });

    expect(result.error_code).toBe('WIDGET_AMBIGUOUS_CHOICE');
    expect(popup.style.display).toBe('none');
  });
});

async function run(controller: FormController, params: unknown, trace = new AgentTrace()) {
  const browser: BrowserToolDeps = {
    controller: controller as unknown as AgentBrowserController,
    ethics: allowingEthics(),
    secretResolver: null,
    secretHosts: () => Promise.resolve([]),
    captureThresholdBytes: 16_384,
  };
  const services = buildServices({ trace, domain: { browser } });
  return wrapTool(browserFillFormSpec(services), services).execute(params, undefined);
}

async function runElement(
  controller: FormController,
  params: unknown,
  trace = new AgentTrace(),
  overrides: Partial<BrowserToolDeps> = {},
  grant = false,
  userInput?: UserInputVault,
) {
  const browser: BrowserToolDeps = {
    controller: controller as unknown as AgentBrowserController,
    ethics: allowingEthics(),
    secretResolver: null,
    secretHosts: () => Promise.resolve([]),
    captureThresholdBytes: 16_384,
    ...overrides,
  };
  let services = buildServices({
    trace,
    ...(userInput ? { userInput } : {}),
    domain: { browser },
  });
  if (grant) {
    const gateway: ConfirmationGateway = {
      request: (request) =>
        Promise.resolve({
          confirmation_id: request.confirmation_id,
          decision: 'granted',
          decided_at: new Date().toISOString(),
          decided_by: 'user_interactive',
        }),
    };
    services = { ...services, confirmation: { gateway, store: null } };
  }
  return {
    result: await wrapTool(browserFillElementSpec(services), services).execute(params, undefined),
    trace,
  };
}

function formController(): FormController {
  const controller = new FormController(
    '<input id="search" aria-label="Search">' +
      '<input id="destination" role="combobox" aria-label="Where to?" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="false">' +
      '<div id="suggestions" role="listbox" style="display:none"><button>Frisco Texas, United States</button><button>Toyota Stadium Frisco, Texas, United States</button></div>' +
      '<button id="dates" aria-label="Dates" aria-controls="calendar" aria-expanded="true">Dates</button>' +
      '<div id="calendar" role="dialog"><table><caption>September 2026</caption><tbody><tr>' +
      '<td><button data-date="2026-09-06">6</button></td><td><button data-date="2026-09-08">8</button></td>' +
      '</tr></tbody></table></div>',
  );
  const destination = controller.document.querySelector<HTMLInputElement>('#destination')!;
  const suggestions = controller.document.querySelector<HTMLElement>('#suggestions')!;
  destination.addEventListener('input', () => {
    destination.setAttribute('aria-expanded', 'true');
    suggestions.style.display = 'block';
  });
  for (const choice of suggestions.querySelectorAll<HTMLButtonElement>('button')) {
    choice.addEventListener('click', () => {
      destination.value = choice.textContent?.trim() ?? '';
      destination.setAttribute('aria-expanded', 'false');
      suggestions.style.display = 'none';
    });
  }
  const dates = controller.document.querySelector<HTMLElement>('#dates')!;
  const selected: string[] = [];
  for (const day of controller.document.querySelectorAll<HTMLButtonElement>('#calendar button')) {
    day.addEventListener('click', () => {
      selected.push(day.textContent?.trim() ?? '');
      dates.setAttribute(
        'aria-label',
        selected
          .slice(-2)
          .map((value) => `Sep ${value}, 2026`)
          .join(' - '),
      );
    });
  }
  controller.document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      controller.document.querySelector<HTMLElement>('#calendar')!.style.display = 'none';
      dates.setAttribute('aria-expanded', 'false');
    }
  });
  return controller;
}

class FormController {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  public readonly clickLog: string[] = [];
  public observationCount = 0;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private nextRef = 1;

  public constructor(html: string) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
    });
    this.window = dom.window;
    this.document = dom.window.document;
    this.refreshRefs();
  }

  public async observe(): Promise<AgentBrowserObservation> {
    this.observationCount += 1;
    this.refreshRefs();
    const interactables: AgentInteractable[] = [...this.elementsByRef].map(([ref, element]) => ({
      ref,
      role:
        element.getAttribute('role') ??
        (element instanceof this.window.HTMLInputElement ? 'textbox' : 'button'),
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      ...(this.valueOf(element) ? { value: this.valueOf(element)! } : {}),
      ...(element.closest('table')?.querySelector('caption')?.textContent
        ? { group: element.closest('table')!.querySelector('caption')!.textContent!.trim() }
        : {}),
    }));
    return {
      url: 'https://example.test/',
      title: 'Form',
      digest: 'form',
      digestUnchanged: false,
      interactables,
    };
  }

  public describeRef(ref: string): AgentInteractable | undefined {
    const element = this.elementsByRef.get(ref);
    return element
      ? {
          ref,
          role:
            element.getAttribute('role') ??
            (element instanceof this.window.HTMLInputElement ? 'textbox' : 'button'),
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
        }
      : undefined;
  }

  public locatorFor(): Promise<[]> {
    return Promise.resolve([]);
  }

  public host(): string {
    return 'example.test';
  }

  public async click(ref: string): Promise<Record<string, never>> {
    const element = this.element(ref);
    this.clickLog.push(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
    element.click();
    return {};
  }

  public async fill(ref: string, value: string): Promise<Record<string, never>> {
    const element = this.element(ref);
    if (!(element instanceof this.window.HTMLInputElement)) throw new Error('not an input');
    element.value = value;
    element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new this.window.Event('change', { bubbles: true }));
    return {};
  }

  public evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    return this.inDom(() => fn(this.element(ref), ...args));
  }

  public evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    return this.inDom(() => fn(...args));
  }

  public async press(key: string): Promise<void> {
    this.document.dispatchEvent(new this.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  public now(): number {
    return Date.now();
  }

  private refreshRefs(): void {
    this.elementsByRef.clear();
    for (const element of this.document.querySelectorAll<HTMLElement>(
      'button,input,select,[role="button"],[role="combobox"],[role="option"],[data-yantra-widget-target]',
    )) {
      let ref = this.refsByElement.get(element);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.refsByElement.set(element, ref);
      }
      this.elementsByRef.set(ref, element);
    }
  }

  private element(ref: string): HTMLElement {
    const element = this.elementsByRef.get(ref);
    if (!element) throw new Error(`unknown ref ${ref}`);
    return element;
  }

  private valueOf(element: HTMLElement): string | null {
    return element instanceof this.window.HTMLInputElement &&
      element.type !== 'password' &&
      element.value
      ? element.value
      : null;
  }

  private async inDom<T>(body: () => T | Promise<T>): Promise<T> {
    const names = [
      'document',
      'window',
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'HTMLTableElement',
      'HTMLTableCellElement',
      'HTMLButtonElement',
    ] as const;
    const prior = new Map<string, PropertyDescriptor | undefined>();
    for (const name of names) {
      prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: name === 'window' ? this.window : this.window[name],
      });
    }
    try {
      return await body();
    } finally {
      for (const name of names) {
        const descriptor = prior.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
}
