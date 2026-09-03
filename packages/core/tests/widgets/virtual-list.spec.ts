import { describe, expect, it } from 'vitest';

import { listboxDriver } from '../../src/widgets/option/listbox-driver.js';
import {
  MAX_TRACKED_OPTION_IDENTITIES,
  optionIdentity,
  scanVirtualOptions,
} from '../../src/widgets/option/virtual-list.js';
import { defaultWidgetBudget, type WidgetBudget } from '../../src/widgets/types.js';
import { countingPort } from '../support/gauntlet.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

/**
 * A listbox that mounts only the rows currently inside its scroll viewport.
 *
 * `rows` is the full model; `windowSize` is how many are ever in the DOM. The
 * mounted window is derived from `scrollTop` on each `scroll` event, which is
 * the behaviour — not just the markup — that makes this the pattern.
 *
 * `recycle` re-mounts the same row identities at every position, which is what
 * a node-derived identity could never tell apart from progress.
 */
function virtualList(options: {
  readonly rows: readonly string[];
  readonly windowSize?: number;
  readonly recycle?: boolean;
  readonly frozen?: boolean;
}): WidgetTestPort {
  const windowSize = options.windowSize ?? 4;
  const port = new WidgetTestPort(
    '<button id="trigger" aria-controls="panel" aria-expanded="true">Region</button>' +
      '<div id="panel" role="listbox" style="overflow-y: auto"><ul id="rows"></ul></div>',
  );
  const document = port.document;
  const panel = document.querySelector('#panel')!;
  const list = document.querySelector('#rows')!;

  const mount = (): void => {
    const start = options.recycle ? 0 : Math.min(panel.scrollTop, options.rows.length - 1);
    list.innerHTML = '';
    for (const label of options.rows.slice(start, start + windowSize)) {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.textContent = label;
      list.appendChild(row);
    }
  };
  if (options.frozen) {
    // A region that will not move: assignment is accepted and then reverted,
    // the way a list pinned at its end behaves.
    Object.defineProperty(panel, 'scrollTop', { get: () => 0, set: () => undefined });
  }
  panel.addEventListener('scroll', mount);
  mount();
  return port;
}

function container(port: WidgetTestPort): { readonly path: readonly number[] } {
  const panel = port.document.querySelector('#panel')!;
  const path: number[] = [];
  let current: Element | null = panel;
  while (current && current !== port.document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return { path };
}

function budget(port: WidgetTestPort, overrides: Partial<WidgetBudget> = {}): WidgetBudget {
  return { ...defaultWidgetBudget(port), ...overrides };
}

const ROWS = Array.from({ length: 24 }, (_, index) => `Region ${index}`);

/** What a first-window commit costs. Measured, then pinned. */
const HOT_PATH_COST = { mutations: 1, reads: 5 };

describe('@no-llm virtualized option scanning', () => {
  it('derives option identity from content, because a virtual list recycles its nodes', () => {
    // A node- or path-derived identity reports the same recycled <li> as a new
    // option forever, and no-progress could never be detected.
    expect(optionIdentity({ name: 'Region 1', role: 'option', disabled: false, path: [0] })).toBe(
      optionIdentity({ name: ' region  1 ', role: 'option', disabled: false, path: [9, 9] }),
    );
    expect(
      optionIdentity({ name: 'Region 1', role: 'option', disabled: false, path: [0] }),
    ).not.toBe(optionIdentity({ name: 'Region 2', role: 'option', disabled: false, path: [0] }));
  });

  it('charges zero scrolls when the target is already in the mounted window', async () => {
    const port = virtualList({ rows: ROWS });
    const counted = countingPort(port);

    const scan = await scanVirtualOptions(counted.port, container(port), 'Region 1', budget(port));

    expect(scan.kind).toBe('match');
    // The entry-condition assertion, counted: a silent extra page action is
    // invisible in every other signal.
    expect(counted.counts.byAction.scrollContainer).toBeUndefined();
    expect(scan.cursor.scrolls).toBe(0);
    expect(scan.cursor.windows).toBe(1);
    expect(scan.cursor.stoppedBecause).toBe('matched');
  });

  it('reaches a row several windows down and reports the exact scroll count', async () => {
    const port = virtualList({ rows: ROWS });
    const counted = countingPort(port);

    // Window 0 mounts rows 0-3, so this row exists only after three scrolls.
    const scan = await scanVirtualOptions(counted.port, container(port), 'Region 6', budget(port));

    expect(scan.kind).toBe('match');
    expect(scan.cursor.stoppedBecause).toBe('matched');
    expect(scan.cursor.scrolls).toBe(3);
    expect(counted.counts.byAction.scrollContainer).toBe(3);
    expect(scan.cursor.windows).toBe(4);
  });

  it('stops after one unproductive window when the list recycles the same rows', async () => {
    const port = virtualList({ rows: ROWS, recycle: true });

    const scan = await scanVirtualOptions(port, container(port), 'Region 20', budget(port));

    expect(scan.kind).toBe('none');
    // Not at the step cap: the second window contributed nothing new, and
    // scrolling again would spend an action to learn nothing.
    expect(scan.cursor.stoppedBecause).toBe('no-new-options');
    expect(scan.cursor.scrolls).toBe(1);
  });

  it('stops when the container will not move', async () => {
    const port = virtualList({ rows: ROWS, frozen: true });

    const scan = await scanVirtualOptions(port, container(port), 'Region 20', budget(port));

    expect(scan.kind).toBe('none');
    expect(scan.cursor.stoppedBecause).toBe('scroll-position-unchanged');
  });

  it('stops at the declared step cap on a long list of unique rows', async () => {
    const port = virtualList({ rows: Array.from({ length: 400 }, (_, i) => `Region ${i}`) });

    const scan = await scanVirtualOptions(port, container(port), 'Nowhere at all', budget(port));

    expect(scan.kind).toBe('none');
    expect(scan.cursor.stoppedBecause).toBe('step-cap');
    expect(scan.cursor.scrolls).toBe(defaultWidgetBudget(port).maxScrollSteps);
  });

  it('stops on the action budget without exceeding it', async () => {
    const port = virtualList({ rows: Array.from({ length: 400 }, (_, i) => `Region ${i}`) });
    const counted = countingPort(port);

    const scan = await scanVirtualOptions(
      counted.port,
      container(port),
      'Nowhere at all',
      budget(port, { maxActions: 5 }),
      { actions: 2 },
    );

    expect(scan.cursor.stoppedBecause).toBe('budget');
    expect(2 + scan.cursor.scrolls).toBeLessThanOrEqual(5);
    expect(counted.counts.byAction.scrollContainer).toBe(scan.cursor.scrolls);
  });

  it('deduplicates offers across windows, in first-seen order, within the shared cap', async () => {
    const port = virtualList({ rows: Array.from({ length: 400 }, (_, i) => `Region ${i}`) });

    const scan = await scanVirtualOptions(port, container(port), 'Nowhere at all', budget(port));

    expect(scan.cursor.offered).toEqual([...new Set(scan.cursor.offered)]);
    expect(scan.cursor.offered.length).toBeLessThanOrEqual(10);
    expect(scan.cursor.offered[0]).toBe('Region 0');
    expect(scan.cursor.seen.size).toBeLessThanOrEqual(MAX_TRACKED_OPTION_IDENTITIES);
  });

  it('detects progress and its absence on a list that recycles nodes with new text', async () => {
    // Same DOM nodes, different text on each window. Progress is visible only
    // because identity is content-derived.
    const advancing = virtualList({ rows: ROWS });
    const advanced = await scanVirtualOptions(
      advancing,
      container(advancing),
      'Region 5',
      budget(advancing),
    );
    expect(advanced.kind).toBe('match');
    expect(advanced.cursor.seen.size).toBeGreaterThan(4);

    const stuck = virtualList({ rows: ROWS, recycle: true });
    const halted = await scanVirtualOptions(stuck, container(stuck), 'Region 20', budget(stuck));
    expect(halted.cursor.stoppedBecause).toBe('no-new-options');
  });

  describe('through the listbox driver', () => {
    it('commits a row that only exists after scrolling, and records the rung', async () => {
      const port = virtualList({ rows: ROWS });
      const counted = countingPort(port);
      const target = {
        ref: port.refFor('#trigger'),
        role: 'button',
        name: 'Region',
        group: null,
        value: null,
      };

      const outcome = await listboxDriver.drive(
        counted.port,
        target,
        { kind: 'option', value: 'Region 6' },
        budget(port),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.chosen).toBe('Region 6');
      const record = outcome.attempted?.[0];
      expect(record).toMatchObject({ strategy: 'scroll-container', axis: 'what', errorCode: null });
      // Bounded count and a structural token only: no page text, no host.
      expect(record?.detail).toBe('scrolled 3, stopped matched');
      expect(counted.counts.byAction.scrollContainer).toBe(3);
    });

    it('charges no scroll and records no rung when the first window answers', async () => {
      const port = virtualList({ rows: ROWS });
      const counted = countingPort(port);
      const target = {
        ref: port.refFor('#trigger'),
        role: 'button',
        name: 'Region',
        group: null,
        value: null,
      };

      const outcome = await listboxDriver.drive(
        counted.port,
        target,
        { kind: 'option', value: 'Region 1' },
        budget(port),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.attempted).toBeUndefined();
      expect(counted.counts.byAction.scrollContainer).toBeUndefined();
      // Pinned exactly, not bounded: the hot path must cost precisely what it
      // cost before this capability existed. A scan that re-read the window it
      // was handed, or took one speculative scroll, moves one of these numbers
      // — which is the only way such a cost is visible at all.
      expect({
        mutations: counted.counts.mutations,
        reads: counted.counts.reads,
      }).toEqual(HOT_PATH_COST);
    });

    it('keeps the unchanged code and cause for a value the list genuinely lacks', async () => {
      const port = virtualList({ rows: ROWS });
      const target = {
        ref: port.refFor('#trigger'),
        role: 'button',
        name: 'Region',
        group: null,
        value: null,
      };

      const outcome = await listboxDriver.drive(
        port,
        target,
        { kind: 'option', value: 'Atlantis' },
        budget(port),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      // No new stable error code: this feature adds none.
      expect(outcome.errorCode).toBe('WIDGET_TARGET_UNREACHABLE');
      expect(outcome.cause).toBe('value-not-offered');
      const offered = outcome.details.offered as readonly string[];
      expect(offered).toEqual([...new Set(offered)]);
      expect(offered.length).toBeGreaterThan(4);
      // The hint may only name a move the engine has an engineered path for.
      // The agent has no scroll tool, so advising a scroll would be a dead end.
      expect(JSON.stringify(outcome.details)).not.toMatch(/scroll/i);
    });
  });
});
