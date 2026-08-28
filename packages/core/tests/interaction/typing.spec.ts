import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  commitText,
  isTruncationOf,
  type AgentBrowserObservation,
  type WidgetBudget,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/index.js';

const BUDGET: WidgetBudget = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxPagingSteps: 12,
  maxActions: 32,
};

/**
 * A jsdom port whose input can be told to misbehave the way real controls do.
 *
 * `dropFirstKeystrokeOnce` reproduces the shape that turned a typed airport
 * code into a two-letter fragment; `rejectsKeystrokes` reproduces a
 * framework-controlled input that re-renders away anything it did not author;
 * `withMask` reproduces an input that rewrites what it is given.
 */
class TypingPort implements WidgetPort {
  public readonly window: JSDOM['window'];
  public readonly input: HTMLInputElement;
  public readonly calls: string[] = [];
  private dropsRemaining = 0;
  private resetting = false;
  private mask: ((value: string) => string) | null = null;
  private clock = 0;

  public constructor() {
    const dom = new JSDOM('<!doctype html><html><body><input id="f" /></body></html>', {
      pretendToBeVisual: true,
    });
    this.window = dom.window;
    this.input = dom.window.document.querySelector('#f')!;
  }

  public dropFirstKeystrokeOnce(): this {
    this.dropsRemaining = 1;
    return this;
  }

  /**
   * Model a framework-controlled input: keystrokes are re-rendered away, and
   * only a write through the prototype setter reaches the component's state.
   */
  public rejectsKeystrokes(): this {
    this.resetting = true;
    return this;
  }

  public withMask(mask: (value: string) => string): this {
    this.mask = mask;
    return this;
  }

  public async observe(): Promise<AgentBrowserObservation> {
    return { url: '', title: '', digest: '', digestUnchanged: false, interactables: [] };
  }

  public async click(): Promise<void> {
    // The typing ladder never clicks; this port only has to satisfy the type.
  }

  public async fill(_ref: string, value: string): Promise<void> {
    this.calls.push('fill');
    this.input.value = '';
    this.write(value);
  }

  public async clear(): Promise<void> {
    this.calls.push('clear');
    this.input.value = '';
  }

  public async type(_ref: string, text: string): Promise<void> {
    this.calls.push('type');
    this.write(text);
  }

  public evaluateOn<T, Args extends readonly unknown[]>(
    _ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    this.calls.push('evaluateOn');
    const globals = globalThis as Record<string, unknown>;
    const saved = {
      HTMLInputElement: globals.HTMLInputElement,
      HTMLTextAreaElement: globals.HTMLTextAreaElement,
      Event: globals.Event,
    };
    globals.HTMLInputElement = this.window.HTMLInputElement;
    globals.HTMLTextAreaElement = this.window.HTMLTextAreaElement;
    globals.Event = this.window.Event;
    try {
      return Promise.resolve(fn(this.input as unknown as HTMLElement, ...args));
    } finally {
      Object.assign(globals, saved);
    }
  }

  public async evaluate<T>(): Promise<T> {
    return undefined as T;
  }

  public async press(): Promise<void> {
    // No popup to dismiss in these fixtures.
  }

  public now(): number {
    this.clock += 5;
    return this.clock;
  }

  /** Apply one keystroke-driven write, honoring the configured misbehavior. */
  private write(text: string): void {
    for (const character of text) {
      if (this.dropsRemaining > 0 && this.input.value.length === 0) {
        this.dropsRemaining -= 1;
        continue;
      }
      // A framework-controlled input re-renders from its own state, so a
      // keystroke it did not author is discarded. The prototype-setter path the
      // last rung uses writes to `input.value` directly and is unaffected.
      if (this.resetting) continue;
      this.input.value += character;
    }
    if (this.mask) this.input.value = this.mask(this.input.value);
  }
}

const target = (): WidgetTarget => ({
  ref: 'e1',
  role: 'combobox',
  name: 'Where from?',
  group: null,
  value: null,
});

describe('@no-llm isTruncationOf', () => {
  it('recognises a dropped leading keystroke as truncation', () => {
    expect(isTruncationOf('FW', 'DFW')).toBe(true);
  });

  it('recognises an empty field as truncation', () => {
    expect(isTruncationOf('', 'DFW')).toBe(true);
  });

  it('does not treat a reformatted value as truncation', () => {
    expect(isTruncationOf('(555) 123-4567', '5551234567')).toBe(false);
  });

  it('does not treat an unrelated shorter value as truncation', () => {
    expect(isTruncationOf('xyz', 'DFW')).toBe(false);
  });

  it('does not treat an exact match as truncation', () => {
    expect(isTruncationOf('DFW', 'DFW')).toBe(false);
  });

  it('treats an empty request as nothing to lose', () => {
    expect(isTruncationOf('', '')).toBe(false);
  });
});

describe('@no-llm commitText escalation ladder', () => {
  it('commits on the first rung when the control behaves', async () => {
    const port = new TypingPort();

    const outcome = await commitText(port, target(), 'DFW', BUDGET);

    expect(outcome).toMatchObject({ ok: true, strategy: 'overtype', committed: 'DFW' });
    expect(outcome.ok && outcome.ledger.records).toHaveLength(1);
  });

  it('escalates to clear-then-type when the control drops the leading keystroke', async () => {
    // The run's "DFW typed, FW observed, Fort Wayne offered" shape.
    const port = new TypingPort().dropFirstKeystrokeOnce();

    const outcome = await commitText(port, target(), 'DFW', BUDGET);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.committed).toBe('DFW');
    expect(outcome.ok && outcome.strategy).toBe('clear-then-type');
    expect(outcome.ok && outcome.ledger.records.map((record) => record.strategy)).toEqual([
      'overtype',
      'clear-then-type',
    ]);
    expect(outcome.ok && outcome.ledger.records[0]?.detail).toBe('kept "FW"');
  });

  it('reaches the native-setter rung for a framework-controlled input', async () => {
    const port = new TypingPort().rejectsKeystrokes();

    const outcome = await commitText(port, target(), 'San Jose', BUDGET);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.strategy).toBe('native-setter');
    expect(outcome.ok && outcome.committed).toBe('San Jose');
  });

  it('accepts a masked reformat on the first rung without fighting it', async () => {
    const port = new TypingPort().withMask((value) =>
      value.length === 10 ? `(${value.slice(0, 3)}) ${value.slice(3, 6)}-${value.slice(6)}` : value,
    );

    const outcome = await commitText(port, target(), '5551234567', BUDGET);

    expect(outcome).toMatchObject({
      ok: true,
      strategy: 'overtype',
      committed: '(555) 123-4567',
      reformatted: true,
    });
    expect(port.calls).toEqual(['fill', 'evaluateOn']);
  });

  it('reports every strategy it tried when the control never holds the value', async () => {
    const port = new TypingPort();
    // A control that swallows everything, on every mechanism.
    Object.defineProperty(port.input, 'value', {
      get: () => '',
      set: () => undefined,
      configurable: true,
    });

    const outcome = await commitText(port, target(), 'DFW', BUDGET);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe('WIDGET_NOT_COMMITTED');
    expect(outcome.observed).toBe('');
    expect(outcome.ledger.records.map((record) => record.strategy)).toEqual([
      'overtype',
      'clear-then-type',
      'native-setter',
    ]);
  });

  it('stops at the deadline mid-ladder and keeps the ledger it built', async () => {
    const port = new TypingPort().rejectsKeystrokes();

    const outcome = await commitText(port, target(), 'San Jose', {
      ...BUDGET,
      deadlineMs: 20,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.ledger.records.length).toBeLessThan(3);
    expect(outcome.ledger.records.length).toBeGreaterThan(0);
  });

  it('refuses before typing when the budget is already spent', async () => {
    const port = new TypingPort();

    const outcome = await commitText(port, target(), 'DFW', { ...BUDGET, deadlineMs: -1 });

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      reason: 'budget',
    });
    expect(port.calls).toEqual([]);
  });

  it('never escalates and never reads the value back when escalation is disallowed', async () => {
    // The secret path. A credential must not reach a ledger or a failure
    // detail, so the readback that would decide escalation is skipped outright.
    const port = new TypingPort().dropFirstKeystrokeOnce();

    const outcome = await commitText(port, target(), 'hunter2', BUDGET, {
      allowEscalation: false,
    });

    expect(outcome).toMatchObject({ ok: true, strategy: 'overtype', committed: '' });
    expect(port.calls).toEqual(['fill']);
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });
});
