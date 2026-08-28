import type { FillElementStep } from '@yantra/protocol';
import type { ElementHandle, KeyInput, Page as PuppeteerPage } from 'puppeteer-core';

import {
  StaleElementRefError,
  type AgentBrowserObservation,
  type AgentInteractable,
} from '../../browser/agent-controller.js';
import { fillField, fillSecretField, parseFillValue, type FillFailure } from '../../fill/index.js';
import { resolveInteractable } from '../../interaction/index.js';
import { defaultWidgetBudget, type WidgetPort, type WidgetTarget } from '../../widgets/types.js';
import type { ExecutionContext, StepHandler, StepResult } from '../types.js';
import { ValueResolver } from '../value-resolver.js';

import { resolveLocatorChain } from './locator-helpers.js';
import { CLICK_NAV_DETECT_MS, FILL_NAV_DETECT_MS, withPageSettling } from './settle-helpers.js';

/** The platform's select-all chord; mirrors the agent controller's choice. */
const SELECT_ALL_MODIFIER: KeyInput = process.platform === 'darwin' ? 'Meta' : 'Control';

const INTERACTABLE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
  '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], ' +
  '[role="option"], [role="gridcell"], [data-yantra-widget-target]';

/** Typed replay failure preserving the engine's stable code and diagnostics. */
export class FillElementExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'FillElementExecutionError';
  }
}

/** Deterministic replay handler for the semantic fill_element verb. */
export const handleFillElement: StepHandler<FillElementStep> = async (
  step,
  ctx,
): Promise<StepResult> => {
  const page = ctx.page?.puppeteerPage;
  if (!page) {
    return failed('unexpected', new Error('fill_element requires a Puppeteer-backed page.'));
  }

  const port = new ReplayWidgetPort(page, ctx);
  try {
    const observation = await port.observe({ cap: 400, trackDigest: false });
    const semantic = resolveField(step.field_name, observation.interactables);
    if (semantic.kind === 'ambiguous') {
      return fromFailure(
        step,
        ctx,
        fillFailure(
          'WIDGET_AMBIGUOUS_CHOICE',
          `Several fields match "${step.field_name}" at the same rank.`,
          { offered: semantic.offered },
        ),
      );
    }

    let target: WidgetTarget;
    if (semantic.kind === 'match') {
      target = toTarget(semantic.target);
    } else {
      if (!ctx.locatorHost) {
        return failed(
          'locator_not_found',
          new FillElementExecutionError(
            'WIDGET_TARGET_UNREACHABLE',
            `No field named "${step.field_name}" was observed and no locator host is available.`,
            { field_name: step.field_name },
          ),
        );
      }
      const located = await resolveLocatorChain(step.locator, step.id, ctx, {
        requirement: 'actionable',
      });
      if (located.kind === 'not_found') {
        if (ctx.budgets.canRetry('step')) {
          return { kind: 'retried', attempt: 1, reason: 'locator_not_found' };
        }
        return failed(
          'locator_not_found',
          new FillElementExecutionError(
            'WIDGET_TARGET_UNREACHABLE',
            `The field "${step.field_name}" and its fallback locator were not found.`,
            { diagnostics: located.diagnostics },
          ),
        );
      }
      if (located.kind === 'error') return failed('unexpected', located.error);
      target = await port.adopt(located.elementHandle, step.field_name);
    }

    return driveFillElement(step, ctx, port, target);
  } catch (error) {
    return failed('unexpected', error instanceof Error ? error : new Error(String(error)));
  } finally {
    port.dispose();
  }
};

/** Execute a resolved replay field; exported for focused handler tests. */
export async function driveFillElement(
  step: FillElementStep,
  ctx: ExecutionContext,
  port: WidgetPort,
  target: WidgetTarget,
): Promise<StepResult> {
  const resolver = new ValueResolver(ctx.captures, ctx.params ?? {}, ctx.secrets);
  if (step.value.kind === 'secret') {
    let resolved;
    try {
      resolved = await resolver.resolveSecret(step.value);
    } catch (error) {
      return failed('validation_error', asError(error));
    }
    try {
      const outcome = await fillSecretField(
        port,
        { field: step.field_name, target },
        resolved.plaintext,
        defaultWidgetBudget(port),
      );
      if (!outcome.ok) return fromFailure(step, ctx, outcome);
      return {
        kind: 'completed',
        details: { driver: outcome.driver, dismissed: outcome.dismissed },
      };
    } finally {
      resolved.zero();
    }
  }

  let raw: string;
  try {
    raw = await resolver.resolveToString(step.value);
  } catch (error) {
    return failed('validation_error', asError(error));
  }
  const intent = parseFillValue(raw, target.role);
  if (!('kind' in intent)) return fromFailure(step, ctx, intent);
  const outcome = await fillField(
    port,
    { field: step.field_name, target },
    intent,
    defaultWidgetBudget(port),
  );
  if (!outcome.ok) return fromFailure(step, ctx, outcome);
  return {
    kind: 'completed',
    details: {
      committed: outcome.committed,
      driver: outcome.driver,
      dismissed: outcome.dismissed,
    },
  };
}

function fromFailure(
  _step: FillElementStep,
  ctx: ExecutionContext,
  failure: FillFailure,
): StepResult {
  if (
    failure.errorCode !== 'FILL_VALUE_INVALID' &&
    failure.retryable &&
    ctx.budgets.canRetry('step')
  ) {
    return { kind: 'retried', attempt: 1, reason: failure.errorCode };
  }
  return failed(
    failure.errorCode === 'WIDGET_TARGET_UNREACHABLE' ? 'locator_not_found' : 'validation_error',
    new FillElementExecutionError(failure.errorCode, failure.message, failure.details),
  );
}

function fillFailure(
  errorCode: FillFailure['errorCode'],
  message: string,
  details: Readonly<Record<string, unknown>>,
): FillFailure {
  return { ok: false, errorCode, message, details, retryable: true };
}

function failed(
  failureClass: 'unexpected' | 'validation_error' | 'locator_not_found',
  error: Error,
): StepResult {
  return { kind: 'failed', failureClass, error };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type FieldResolution =
  | { readonly kind: 'match'; readonly target: AgentInteractable }
  | { readonly kind: 'ambiguous'; readonly offered: readonly string[] }
  | { readonly kind: 'none' };

/** Replay resolves fields through the same shared resolver as the live tools. */
function resolveField(field: string, interactables: readonly AgentInteractable[]): FieldResolution {
  const resolved = resolveInteractable(field, interactables);
  if (resolved.kind === 'match') return { kind: 'match', target: resolved.entry };
  if (resolved.kind === 'none') return { kind: 'none' };
  return { kind: 'ambiguous', offered: resolved.offered.slice(0, 10).map((entry) => entry.name) };
}

function toTarget(entry: AgentInteractable): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}

class ReplayWidgetPort implements WidgetPort {
  private readonly refs = new Map<string, ElementHandle<Element>>();
  private readonly refByIdentity = new Map<string, string>();
  private nextRef = 1;

  public constructor(
    private readonly page: PuppeteerPage,
    private readonly ctx: ExecutionContext,
  ) {}

  public async observe(
    options: { readonly cap?: number; readonly trackDigest?: boolean } = {},
  ): Promise<AgentBrowserObservation> {
    const cap = Math.min(Math.max(1, options.cap ?? 50), 400);
    const handles = await this.page.$$(INTERACTABLE_SELECTOR);
    const next = new Map<string, ElementHandle<Element>>();
    const interactables: AgentInteractable[] = [];
    const ordinals = new Map<string, number>();
    for (const handle of handles) {
      if (interactables.length >= cap) {
        dispose(handle);
        continue;
      }
      const described = await describe(handle).catch(() => null);
      if (!described) {
        dispose(handle);
        continue;
      }
      const ordinalKey = `${described.role}\u0000${described.name}`;
      const ordinal = ordinals.get(ordinalKey) ?? 0;
      ordinals.set(ordinalKey, ordinal + 1);
      const identity = `${ordinalKey}\u0000${ordinal}`;
      let ref = this.refByIdentity.get(identity);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.refByIdentity.set(identity, ref);
      }
      next.set(ref, handle);
      interactables.push({ ref, ...described });
    }
    for (const [ref, handle] of this.refs) {
      if (next.get(ref) !== handle) dispose(handle);
    }
    this.refs.clear();
    for (const [ref, handle] of next) this.refs.set(ref, handle);
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      digest: '',
      digestUnchanged: false,
      interactables,
    };
  }

  public async adopt(handle: ElementHandle<Element>, fieldName: string): Promise<WidgetTarget> {
    const described = (await describe(handle)) ?? { role: 'textbox', name: fieldName };
    const ref = `e${this.nextRef++}`;
    this.refs.set(ref, handle);
    return toTarget({ ref, ...described });
  }

  public async click(ref: string): Promise<void> {
    const handle = this.handle(ref);
    await withPageSettling(this.ctx, CLICK_NAV_DETECT_MS, () => handle.click());
  }

  public async fill(ref: string, value: string): Promise<void> {
    const handle = this.handle(ref);
    await withPageSettling(this.ctx, FILL_NAV_DETECT_MS, async () => {
      const selected = await this.evaluateOn(
        ref,
        (element, wanted) => {
          if (!(element instanceof HTMLSelectElement)) return false;
          const option = Array.from(element.options).find(
            (candidate) =>
              candidate.value === wanted ||
              (candidate.label || candidate.text).trim() === wanted.trim(),
          );
          if (!option) return true;
          element.value = option.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
        value,
      );
      if (selected) return;
      await handle.focus();
      await handle.click({ clickCount: 3 });
      await handle.type(value);
    });
  }

  public async clear(ref: string): Promise<void> {
    const handle = this.handle(ref);
    await withPageSettling(this.ctx, FILL_NAV_DETECT_MS, async () => {
      await handle.focus();
      await this.page.keyboard.down(SELECT_ALL_MODIFIER);
      await this.page.keyboard.press('a');
      await this.page.keyboard.up(SELECT_ALL_MODIFIER);
      await this.page.keyboard.press('Backspace');
    });
  }

  public async type(
    ref: string,
    text: string,
    options: { readonly delayMs?: number } = {},
  ): Promise<void> {
    const handle = this.handle(ref);
    await withPageSettling(this.ctx, FILL_NAV_DETECT_MS, async () => {
      await handle.focus();
      await handle.type(text, { delay: options.delayMs ?? 0 });
    });
  }

  public evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    const handle = this.handle(ref);
    const evaluate = handle.evaluate.bind(handle) as unknown as (
      operation: (element: HTMLElement, ...values: Args) => T | Promise<T>,
      ...values: Args
    ) => Promise<T>;
    return evaluate(fn, ...args).catch((error) => {
      if (/detached|context|disposed|not connected/i.test(asError(error).message)) {
        throw new StaleElementRefError(ref);
      }
      throw error;
    });
  }

  public evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    const evaluate = this.page.evaluate.bind(this.page) as unknown as (
      operation: (...values: Args) => T | Promise<T>,
      ...values: Args
    ) => Promise<T>;
    return evaluate(fn, ...args);
  }

  public async press(key: string): Promise<void> {
    await this.page.keyboard.press(key as KeyInput);
  }

  public now(): number {
    return this.ctx.clock.now();
  }

  public dispose(): void {
    for (const handle of this.refs.values()) dispose(handle);
    this.refs.clear();
  }

  private handle(ref: string): ElementHandle<Element> {
    const handle = this.refs.get(ref);
    if (!handle) throw new StaleElementRefError(ref);
    return handle;
  }
}

function describe(handle: ElementHandle<Element>): Promise<Omit<AgentInteractable, 'ref'> | null> {
  return handle.evaluate((element) => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      element.hidden ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      rect.width === 0 ||
      rect.height === 0
    ) {
      return null;
    }
    const normalize = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const nameOf = (): string => {
      const aria = normalize(element.getAttribute('aria-label'));
      if (aria) return aria;
      const labelled = (element.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .map((id) => normalize(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ');
      if (labelled) return labelled;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const linked = element.id
          ? normalize(
              document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)
                ?.textContent,
            )
          : '';
        return (
          linked ||
          normalize(element.closest('label')?.textContent) ||
          normalize(element.placeholder)
        );
      }
      return normalize(element.textContent);
    };
    const roleOf = (): string => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      if (element instanceof HTMLInputElement) {
        const type = element.type.toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (element instanceof HTMLSelectElement) return 'combobox';
      if (element instanceof HTMLTextAreaElement) return 'textbox';
      if (element instanceof HTMLAnchorElement) return 'link';
      return 'button';
    };
    const groupElement = element.closest('fieldset,[role="group"],[role="dialog"],form');
    const group = groupElement
      ? normalize(
          groupElement.querySelector('legend')?.textContent ??
            groupElement.getAttribute('aria-label') ??
            groupElement.querySelector('h1,h2,h3')?.textContent,
        )
      : '';
    const sensitive =
      element.matches('input[type="password"]') ||
      /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i.test(
        element.getAttribute('autocomplete') ?? '',
      );
    const value =
      !sensitive &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement)
        ? normalize(element.value)
        : '';
    return {
      role: roleOf(),
      name: nameOf(),
      ...(group ? { group } : {}),
      ...(value ? { value } : {}),
      ...(sensitive && element instanceof HTMLInputElement && element.value
        ? { value_present: true as const }
        : {}),
      ...(element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? { checked: element.checked }
        : {}),
      ...(element.getAttribute('aria-expanded') !== null
        ? { expanded: element.getAttribute('aria-expanded') === 'true' }
        : {}),
      ...(element.getAttribute('aria-selected') !== null
        ? { selected: element.getAttribute('aria-selected') === 'true' }
        : {}),
    };
  });
}

function dispose(handle: ElementHandle<Element>): void {
  void Promise.resolve(handle.dispose()).catch(() => undefined);
}
