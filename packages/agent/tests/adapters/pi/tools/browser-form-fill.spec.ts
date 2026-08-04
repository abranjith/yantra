import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentBrowserController,
  AgentBrowserObservation,
  AgentInteractable,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserFormFillSpec } from '../../../../src/adapters/pi/tools/browser-form-fill.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { RunServices } from '../../../../src/runtime/run-services.js';
import { AgentTrace } from '../../../../src/runtime/trace.js';

import { assertToolContract, buildServices } from './test-support.js';

type Entry = readonly [ref: string, role: string, name: string];

function observationOf(entries: readonly Entry[]): AgentBrowserObservation {
  return {
    url: 'https://www.kayak.com/hotels',
    title: 'Hotels',
    digest: 'Find your stay',
    interactables: entries.map(([ref, role, name]) => ({ ref, role, name })),
  };
}

/**
 * A scripted page: `observe()` returns the current stage, and clicking or
 * filling a ref can advance to the next one — the way a real form reveals
 * autocomplete options and calendar cells only after the preceding step.
 */
class ScriptedPage {
  public stage: readonly Entry[];
  public readonly fills: { ref: string; value: string }[] = [];
  public readonly clicks: string[] = [];
  /** Transitions applied when a given ref is clicked or filled. */
  private readonly onFill = new Map<string, readonly Entry[]>();
  private readonly onClick = new Map<string, readonly Entry[]>();

  public constructor(initial: readonly Entry[]) {
    this.stage = initial;
  }

  public revealOnFill(ref: string, next: readonly Entry[]): this {
    this.onFill.set(ref, next);
    return this;
  }

  public revealOnClick(ref: string, next: readonly Entry[]): this {
    this.onClick.set(ref, next);
    return this;
  }

  public controller(): AgentBrowserController {
    return {
      observe: () => Promise.resolve(observationOf(this.stage)),
      fill: (ref: string, value: string) => {
        this.fills.push({ ref, value });
        const next = this.onFill.get(ref);
        if (next) this.stage = next;
        return Promise.resolve({ url: 'https://www.kayak.com/hotels', title: 'Hotels' });
      },
      click: (ref: string) => {
        this.clicks.push(ref);
        const next = this.onClick.get(ref);
        if (next) this.stage = next;
        return Promise.resolve({ url: 'https://www.kayak.com/hotels', title: 'Hotels' });
      },
      host: () => 'www.kayak.com',
      describeRef: (ref: string): AgentInteractable | undefined => {
        const found = this.stage.find(([entryRef]) => entryRef === ref);
        return found ? { ref: found[0], role: found[1], name: found[2] } : undefined;
      },
      locatorFor: () => Promise.resolve([]),
    } as unknown as AgentBrowserController;
  }
}

/** The kayak hotels form as observed: a combobox and two calendar buttons. */
const KAYAK_FORM: readonly Entry[] = [
  ['e14', 'combobox', 'Where to?'],
  ['e20', 'button', 'Check-in'],
  ['e21', 'button', 'Check-out'],
  // The marketing tile the logged run mistook for a suggestion.
  ['e38', 'link', 'View more deals for Chicago Hotels'],
  ['e40', 'button', 'Search'],
];

describe('@no-llm browser_form_fill', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-form-fill-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function services(page: ScriptedPage, trace?: AgentTrace): RunServices {
    return buildServices({
      runDir,
      ...(trace ? { trace } : {}),
      domain: {
        browser: {
          controller: page.controller(),
          ethics: { check: () => Promise.resolve() },
          secretResolver: null,
          secretHosts: () => Promise.resolve([]),
          captureThresholdBytes: 1024,
        },
      },
    });
  }

  function run(
    page: ScriptedPage,
    fields: unknown,
    trace?: AgentTrace,
  ): ReturnType<ReturnType<typeof wrapTool>['execute']> {
    const svc = services(page, trace);
    return wrapTool(browserFormFillSpec(svc), svc).execute({ fields }, undefined);
  }

  it('passes the reusable tool contract harness', async () => {
    const svc = services(new ScriptedPage(KAYAK_FORM));
    await assertToolContract(browserFormFillSpec(svc), { fields: 'not an array' });
  });

  it('fills a kayak-shaped form end to end and returns the submit button', async () => {
    const page = new ScriptedPage(KAYAK_FORM)
      .revealOnFill('e14', [
        ...KAYAK_FORM,
        ['e50', 'option', 'Chicago, IL, United States'],
        ['e51', 'option', 'Chicago Midway, IL'],
      ])
      .revealOnClick('e20', [...KAYAK_FORM, ['e60', 'button', 'August 5, 2026']])
      .revealOnClick('e21', [...KAYAK_FORM, ['e61', 'button', 'August 7, 2026']]);

    const result = await run(page, [
      { field: 'Where to?', value: 'Chicago, IL, United States', pick_suggestion: true },
      { field: 'Check-in', value: '2026-08-05' },
      { field: 'Check-out', value: '2026-08-07' },
    ]);

    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as {
      interactables: AgentInteractable[];
      applied: { field: string; action: string }[];
    };
    expect(payload.applied.map((entry) => entry.action)).toEqual([
      'picked_suggestion',
      'chose_in_widget',
      'chose_in_widget',
    ]);
    // The agent can now see the submit button and click it itself.
    expect(payload.interactables.some((entry) => entry.name === 'Search')).toBe(true);
  });

  it('clicks the real option, not the same-named marketing tile (the e38 confusion)', async () => {
    // The logged failure exactly: `e38` was "View more deals for Chicago
    // Hotels", not a suggestion. Only role="option" elements are eligible.
    const page = new ScriptedPage(KAYAK_FORM).revealOnFill('e14', [
      ...KAYAK_FORM,
      ['e50', 'option', 'Chicago, IL, United States'],
    ]);

    const result = await run(page, [
      { field: 'Where to?', value: 'Chicago', pick_suggestion: true },
    ]);

    expect(result.status).toBe('ok');
    expect(page.clicks).toEqual(['e50']);
    expect(page.clicks).not.toContain('e38');
  });

  it('returns SUGGESTION_NOT_OFFERED when no option appears in the window', async () => {
    // No transition registered: filling reveals nothing.
    const page = new ScriptedPage(KAYAK_FORM);

    const result = await run(page, [
      { field: 'Where to?', value: 'Chicago', pick_suggestion: true },
    ]);

    expect(result.error_code).toBe('SUGGESTION_NOT_OFFERED');
    expect(page.fills).toEqual([{ ref: 'e14', value: 'Chicago' }]);
  }, 15_000);

  it('matches a rendered "August 5, 2026" day from an ISO value', async () => {
    const page = new ScriptedPage(KAYAK_FORM).revealOnClick('e20', [
      ...KAYAK_FORM,
      ['e60', 'button', 'August 4, 2026'],
      ['e61', 'button', 'August 5, 2026'],
      ['e62', 'button', 'August 6, 2026'],
    ]);

    const result = await run(page, [{ field: 'Check-in', value: '2026-08-05' }]);

    expect(result.status).toBe('ok');
    expect(page.clicks).toEqual(['e20', 'e61']);
  });

  it('matches a loose calendar cell carrying the month and day', async () => {
    const page = new ScriptedPage(KAYAK_FORM).revealOnClick('e20', [
      ...KAYAK_FORM,
      ['e60', 'button', 'Wednesday, August 5'],
    ]);

    const result = await run(page, [{ field: 'Check-in', value: '2026-08-05' }]);

    expect(result.status).toBe('ok');
    expect(page.clicks).toEqual(['e20', 'e60']);
  });

  it('returns FORM_WIDGET_NO_MATCH when the opened widget has no matching day', async () => {
    const page = new ScriptedPage(KAYAK_FORM).revealOnClick('e20', [
      ...KAYAK_FORM,
      ['e60', 'button', 'September 9, 2026'],
    ]);

    const result = await run(page, [{ field: 'Check-in', value: '2026-08-05' }]);

    expect(result.error_code).toBe('FORM_WIDGET_NO_MATCH');
    expect(result.modelText).toContain('2026-08-05');
    expect(result.modelText).toContain('September 9, 2026');
  });

  it('returns FORM_FIELD_NOT_FOUND with candidates for an unknown field', async () => {
    const result = await run(new ScriptedPage(KAYAK_FORM), [
      { field: 'Passport number', value: 'X' },
    ]);

    expect(result.error_code).toBe('FORM_FIELD_NOT_FOUND');
    expect(result.modelText).toContain('Where to?');
  });

  it('returns FORM_FIELD_AMBIGUOUS rather than picking one of two dates', async () => {
    const result = await run(new ScriptedPage(KAYAK_FORM), [{ field: 'Check-', value: 'X' }]);

    expect(result.error_code).toBe('FORM_FIELD_AMBIGUOUS');
    expect(result.modelText).toContain('Check-in');
    expect(result.modelText).toContain('Check-out');
  });

  it('stops at the first failing field and reports what was applied', async () => {
    const page = new ScriptedPage(KAYAK_FORM);

    const result = await run(page, [
      { field: 'Where to?', value: 'Chicago' },
      { field: 'Nonexistent field', value: 'X' },
      { field: 'Check-out', value: '2026-08-07' },
    ]);

    expect(result.error_code).toBe('FORM_FIELD_NOT_FOUND');
    // The first field really was applied; the third was never attempted.
    expect(page.fills).toEqual([{ ref: 'e14', value: 'Chicago' }]);
    expect(page.clicks).toEqual([]);
  });

  it('refuses a credential-shaped value before touching the page', async () => {
    const page = new ScriptedPage(KAYAK_FORM);

    const result = await run(page, [
      { field: 'Where to?', value: 'Chicago' },
      { field: 'Check-in', value: 'sk-ABCDEF0123456789abcdef0123' },
    ]);

    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(result.modelText).toContain('browser_fill');
    // Nothing was filled: the guard runs across the whole list up front, so the
    // form is never left half-completed by a credential mistake.
    expect(page.fills).toEqual([]);
  });

  it('rejects an object-shaped value at schema validation', async () => {
    const result = await run(new ScriptedPage(KAYAK_FORM), [
      { field: 'Where to?', value: { kind: 'literal', value: 'Chicago' } },
    ]);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('INVALID_INPUT');
  });

  it('rejects an empty and an over-long field list', async () => {
    const page = new ScriptedPage(KAYAK_FORM);
    expect((await run(page, [])).error_code).toBe('INVALID_INPUT');
    const tooMany = Array.from({ length: 11 }, () => ({ field: 'Where to?', value: 'x' }));
    expect((await run(page, tooMany)).error_code).toBe('INVALID_INPUT');
  });

  it.each(['checkbox', 'radio'])('returns FORM_FIELD_UNSUPPORTED_ROLE for a %s', async (role) => {
    const page = new ScriptedPage([['e1', role, 'I agree']]);

    const result = await run(page, [{ field: 'I agree', value: 'true' }]);

    expect(result.error_code).toBe('FORM_FIELD_UNSUPPORTED_ROLE');
    expect(result.modelText).toContain('browser_click');
  });

  it('appends a masked trace entry per applied field', async () => {
    const trace = new AgentTrace();
    const page = new ScriptedPage(KAYAK_FORM).revealOnClick('e20', [
      ...KAYAK_FORM,
      ['e60', 'button', 'August 5, 2026'],
    ]);

    await run(
      page,
      [
        { field: 'Where to?', value: 'Chicago' },
        { field: 'Check-in', value: '2026-08-05' },
      ],
      trace,
    );

    const steps = trace.steps();
    expect(steps.map((step) => step.kind)).toEqual(['fill', 'click', 'click']);
    const fill = steps[0] as { value: { kind: string; value: string }; submit: boolean };
    expect(fill.value).toEqual({ kind: 'literal', value: 'Chicago' });
    // The tool never submits, so no traced step may claim it did.
    expect(steps.every((step) => !('submit' in step) || step.submit === false)).toBe(true);
  });

  it('never resolves a secret and declares no confirmation surface', () => {
    const svc = services(new ScriptedPage(KAYAK_FORM));
    const spec = browserFormFillSpec(svc);

    expect(spec.requiresConfirmation).toBeUndefined();
    expect(spec.mutating).toBe(true);
    expect(spec.sanitizationProfile).toBe('authenticated');
    expect(JSON.stringify(spec.parameters)).not.toContain('secret_ref');
  });

  it('accepts an eNN ref as a field address', async () => {
    const page = new ScriptedPage(KAYAK_FORM);

    const result = await run(page, [{ field: 'e14', value: 'Chicago' }]);

    expect(result.status).toBe('ok');
    expect(page.fills).toEqual([{ ref: 'e14', value: 'Chicago' }]);
  });

  it('returns BROWSER_UNAVAILABLE when no browser is configured', async () => {
    const svc = buildServices({ runDir, domain: { browser: null } });
    const result = await wrapTool(browserFormFillSpec(svc), svc).execute(
      { fields: [{ field: 'Where to?', value: 'x' }] },
      undefined,
    );

    expect(result.error_code).toBe('BROWSER_UNAVAILABLE');
  });

  it('does not submit the form', async () => {
    const page = new ScriptedPage(KAYAK_FORM);

    const result = await run(page, [{ field: 'Where to?', value: 'Chicago' }]);

    expect(page.clicks).not.toContain('e40');
    expect(result.modelText).toContain('Nothing was submitted');
  });
});

describe('@no-llm browser_form_fill suggestion timing', () => {
  it('waits for a late-arriving suggestion instead of acting on what is on screen', async () => {
    vi.useFakeTimers();
    try {
      // A suggestion that appears after the first poll must still be found:
      // the logged run failed precisely by acting on the initial screen.
      const page = new ScriptedPage(KAYAK_FORM);
      const runDir = await mkdtemp(join(tmpdir(), 'yantra-form-fill-late-'));
      const svc = buildServices({
        runDir,
        domain: {
          browser: {
            controller: page.controller(),
            ethics: { check: () => Promise.resolve() },
            secretResolver: null,
            secretHosts: () => Promise.resolve([]),
            captureThresholdBytes: 1024,
          },
        },
      });
      const pending = wrapTool(browserFormFillSpec(svc), svc).execute(
        { fields: [{ field: 'Where to?', value: 'Chicago', pick_suggestion: true }] },
        undefined,
      );

      await vi.advanceTimersByTimeAsync(300);
      page.stage = [...KAYAK_FORM, ['e50', 'option', 'Chicago, IL, United States']];
      await vi.advanceTimersByTimeAsync(600);

      const result = await pending;
      expect(result.status).toBe('ok');
      expect(page.clicks).toEqual(['e50']);
      await rm(runDir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
