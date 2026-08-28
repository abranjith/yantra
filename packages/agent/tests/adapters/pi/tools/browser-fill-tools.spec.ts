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
        // The trigger writes its selection into `aria-label` and keeps "Dates"
        // as its text; other pickers do the opposite (KAYAK labels itself
        // "Select start date from calendar input" forever and shows "Sun 9/6").
        // Neither surface can be declared the value without knowing the site,
        // so the committed read is what the control says about itself, both
        // parts, value first.
        committed: 'Sep 6, 2026 - Sep 8, 2026 Dates',
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

  it('tells the model what to do next in the message, not only in details', async () => {
    const controller = new FormController(
      '<div id="city" role="combobox" aria-label="City" aria-controls="choices" aria-expanded="true"></div>' +
        '<div id="choices" role="listbox"><button role="option">New York, NY</button><button role="option">New York, USA</button></div>',
    );

    const result = await run(controller, { fields: [{ field: 'City', value: 'New York' }] });

    // A bare typed code is what pushed the model off these tools and onto raw
    // clicks, so the one actionable sentence has to be where it cannot miss it.
    // The hint now carries the offered strings themselves rather than pointing
    // at `details.offered` — the caller can act on the message alone.
    // modelText is JSON, so the quotes around each option arrive escaped.
    expect(result.modelText).toContain('New York, NY');
    expect(result.modelText).toContain('New York, USA');
    expect(result.modelText).toContain('exactly as written');
  });

  it('surfaces the resolution when the widget commits a value of its own', async () => {
    // The motivating run's first failure, at the tool seam: the model must be
    // able to read "I asked for DFW, the field holds Dallas, that is the widget
    // resolving my value" without inferring any of it.
    const controller = new FormController(
      '<input id="from" role="combobox" aria-label="Where from?" aria-autocomplete="list" ' +
        'aria-controls="opts" aria-expanded="false">' +
        '<div id="opts" role="listbox" style="display:none">' +
        '<button role="option">Dallas Fort Worth International Airport (DFW)</button></div>',
    );
    const input = controller.document.querySelector<HTMLInputElement>('#from')!;
    const popup = controller.document.querySelector<HTMLElement>('#opts')!;
    input.addEventListener('input', () => {
      input.setAttribute('aria-expanded', 'true');
      popup.style.display = 'block';
    });
    popup.querySelector('button')!.addEventListener('click', () => {
      input.value = 'Dallas';
      input.setAttribute('aria-expanded', 'false');
      popup.style.display = 'none';
    });

    const result = await run(controller, { fields: [{ field: 'Where from?', value: 'DFW' }] });
    const model = JSON.parse(result.modelText) as {
      readonly applied: readonly Record<string, unknown>[];
    };

    expect(result.status).toBe('ok');
    expect(model.applied[0]).toMatchObject({
      field: 'Where from?',
      requested: 'DFW',
      committed: 'Dallas',
      resolution: 'single_offered_match',
    });
    expect(String(model.applied[0]?.note)).toContain('not a failure');
  });

  it('reports a plain unchanged fill as exact and adds no note', async () => {
    const controller = new FormController('<input id="q" aria-label="Search">');

    const result = await run(controller, { fields: [{ field: 'Search', value: 'boots' }] });
    const model = JSON.parse(result.modelText) as {
      readonly applied: readonly Record<string, unknown>[];
    };

    expect(model.applied[0]).toMatchObject({ resolution: 'exact', committed: 'boots' });
    expect(model.applied[0]).not.toHaveProperty('note');
  });

  it('re-resolves the field and drives again when the page replaces the control', async () => {
    // The single-page shape from the run: opening the picker re-mounts the
    // trigger and clones it into the popup, so the engine's own re-acquisition
    // can be outrun and the caller is left holding a target that no longer
    // exists. Re-resolving by the caller's field name is the recovery the model
    // would otherwise perform by hand — which is what pulled it into operating
    // the calendar with raw clicks.
    const controller = new FormController(
      '<div id="host"><input id="ci" aria-label="Check-in" aria-controls="cal" value="Aug 10"></div>' +
        '<div id="cal" role="dialog" style="display:none">' +
        '<table><caption>September 2026</caption><tbody><tr>' +
        '<td><button data-date="2026-09-06">6</button></td></tr></tbody></table></div>',
    );
    const popup = controller.document.querySelector<HTMLElement>('#cal')!;
    const bind = (): void => {
      controller.document.querySelector<HTMLElement>('#ci')!.addEventListener(
        'click',
        () => {
          popup.style.display = 'block';
          // Opening mounts a second control with the same name inside the
          // popup and re-mounts the trigger, exactly as the real page does.
          const duplicate = controller.document.createElement('input');
          duplicate.setAttribute('aria-label', 'Check-in');
          duplicate.value = 'Aug 10';
          popup.prepend(duplicate);
          const previous = controller.document.querySelector<HTMLElement>('#ci')!;
          previous.replaceWith(previous.cloneNode(true));
          bind();
        },
        { once: true },
      );
    };
    bind();
    controller.document.querySelector<HTMLElement>('#cal button')!.addEventListener('click', () => {
      controller.document.querySelector<HTMLInputElement>('#ci')!.value = 'Sep 6';
    });
    controller.document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      popup.style.display = 'none';
      popup.querySelector('input')?.remove();
    });

    const result = await run(controller, { fields: [{ field: 'Check-in', value: '2026-09-06' }] });

    expect(result.error_code).toBeUndefined();
    expect(controller.document.querySelector<HTMLInputElement>('#ci')!.value).toBe('Sep 6');
  });

  it('sets both ends of a date range as one range, not two single dates', async () => {
    const controller = rangePickerController();

    const result = await run(controller, {
      fields: [
        { field: 'Check-in', value: '2026-09-06' },
        { field: 'Check-out', value: '2026-09-12' },
      ],
    });

    // The picker commits the pair and nothing less, so driven as two
    // independent fills the first can never survive its own release however
    // carefully it is retried. A caller sending both ends is asking for a
    // range; the tool now says so instead of taking the request apart.
    expect(result.error_code).toBeUndefined();
    expect(controller.dateClicks).toEqual(['2026-09-06', '2026-09-12']);
    expect(controller.document.querySelector<HTMLInputElement>('#ci')!.value).toBe('Sep 6');
    expect(controller.document.querySelector<HTMLInputElement>('#co')!.value).toBe('Sep 12');
    // One fill, reported as accounting for both fields the caller named.
    expect(appliedFields(result.modelText)).toEqual([['Check-in', 'Check-out']]);
  });

  it('leaves two unrelated dates as separate fills', async () => {
    const controller = new FormController(
      '<input id="a" type="date" aria-label="Born on">' +
        '<input id="b" type="date" aria-label="Hired on">',
    );

    const result = await run(controller, {
      fields: [
        { field: 'Born on', value: '1990-04-01' },
        { field: 'Hired on', value: '2020-04-01' },
      ],
    });

    // Fusion is for the two ends of one range. Two dates the page does not
    // label as a pair are two dates.
    expect(result.error_code).toBeUndefined();
    expect(appliedFields(result.modelText)).toEqual([['Born on'], ['Hired on']]);
  });
});

/** The caller fields each reported fill accounts for, in order. */
function appliedFields(modelText: string | undefined): readonly (readonly string[])[] {
  const model = JSON.parse(modelText ?? '{}') as {
    readonly applied?: readonly { readonly field: string; readonly covers?: readonly string[] }[];
  };
  return (model.applied ?? []).map((entry) => entry.covers ?? [entry.field]);
}

/**
 * A check-in/check-out picker that only ever commits a complete range, the
 * shape measured on the page behind the run this fixes.
 */
function rangePickerController(): FormController {
  const controller = new FormController(
    '<input id="ci" aria-label="Check-in" aria-controls="cal" value="Aug 10">' +
      '<input id="co" aria-label="Check-out" value="Aug 11">' +
      '<div id="cal" role="dialog" style="display:none">' +
      '<table><caption>September 2026</caption><tbody><tr>' +
      '<td><button data-date="2026-09-06">6</button></td>' +
      '<td><button data-date="2026-09-12">12</button></td>' +
      '</tr></tbody></table></div>',
  );
  const popup = controller.document.querySelector<HTMLElement>('#cal')!;
  const from = controller.document.querySelector<HTMLInputElement>('#ci')!;
  const to = controller.document.querySelector<HTMLInputElement>('#co')!;
  let committed: readonly [string, string] = [from.value, to.value];
  let pending: string[] = [];

  from.addEventListener('click', () => {
    popup.style.display = 'block';
    pending = [];
  });
  for (const button of controller.document.querySelectorAll<HTMLElement>('#cal button')) {
    button.addEventListener('click', () => {
      controller.dateClicks.push(button.getAttribute('data-date')!);
      if (pending.length >= 2) pending = [];
      pending.push(
        `${button.getAttribute('data-date')!.slice(5, 7) === '09' ? 'Sep' : '?'} ${button.textContent}`,
      );
      [from.value, to.value] = [pending[0] ?? '', pending[1] ?? ''];
    });
  }
  controller.document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    popup.style.display = 'none';
    if (pending.length === 2) committed = [pending[0]!, pending[1]!];
    [from.value, to.value] = committed;
    pending = [];
  });
  return controller;
}

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
  /** Day cells clicked, in order, for tests that care how a range was driven. */
  public readonly dateClicks: string[] = [];
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
    // Mirror the real controller: a node that has left the document is a typed
    // stale-ref failure, which is what drives re-acquisition and retry.
    if (!element || !this.document.contains(element)) {
      const error: Error & { code?: string } = new Error(`Element ref "${ref}" is stale.`);
      error.code = 'STALE_ELEMENT_REF';
      throw error;
    }
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
