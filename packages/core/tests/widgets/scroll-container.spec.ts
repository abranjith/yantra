import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { Logger } from '../../src/browser/types.js';
import { comboboxDriver } from '../../src/widgets/combobox/combobox-driver.js';
import { calendarDriver } from '../../src/widgets/date/calendar-driver.js';
import { dateInputDriver } from '../../src/widgets/date/date-input-driver.js';
import { listboxDriver } from '../../src/widgets/option/listbox-driver.js';
import { nativeSelectDriver } from '../../src/widgets/option/native-select-driver.js';
import { defaultWidgetBudget, type ScrollFrame, type WidgetPort } from '../../src/widgets/types.js';
import { PORT_ACTION_KIND, countingPort } from '../support/gauntlet.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

/** Every registered driver, so a new one cannot quietly skip this rule. */
const DRIVERS = [
  nativeSelectDriver,
  listboxDriver,
  comboboxDriver,
  dateInputDriver,
  calendarDriver,
] as const;

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * A list whose rows overflow a container that owns its own scroll region, on a
 * page that is *also* window-scrollable.
 *
 * The window-scrollable body is the point: "scroll only the owning container"
 * is unfalsifiable on a page that cannot scroll, and moving the whole page
 * under an agent that asked for a list to advance is the failure this guards.
 */
const SCROLLABLE_LIST = `
  <style>
    body { height: 4000px; }
    #panel { height: 120px; overflow-y: auto; }
    #panel li { height: 40px; }
  </style>
  <div id="panel" role="listbox">
    <ul>${Array.from({ length: 40 }, (_, index) => `<li role="option">Row ${index}</li>`).join('')}</ul>
  </div>
  <div id="plain"><span>Nothing scrollable in here</span></div>
`;

/** The child-index chain the widget container address is expressed as. */
function pathOf(element: Element, root: Element): readonly number[] {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== root) {
    const parent: Element | null = current.parentElement;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return path;
}

describe('@no-llm widget port container scrolling', () => {
  it('classifies the action as a mutation, so revealed rows are paid for', () => {
    // The typed `Record<keyof WidgetPort, PortActionKind>` is what makes this
    // mandatory rather than remembered: a new port method that is not
    // classified does not compile. This asserts the classification is the
    // right one — counting it as a read would let a driver reveal an unbounded
    // number of options for free.
    expect(PORT_ACTION_KIND.scrollContainer).toBe('mutation');
  });

  it('declares a scroll-step cap on the budget rather than hiding one in a driver', () => {
    expect(defaultWidgetBudget({ now: () => 0 }).maxScrollSteps).toBe(8);
  });

  describe('jsdom test port', () => {
    it('advances the container own region and reports a frame', async () => {
      const port = new WidgetTestPort(SCROLLABLE_LIST);
      const panel = port.document.querySelector('#panel')!;

      const frame = await port.scrollContainer({
        path: pathOf(panel, port.document.documentElement),
      });

      expect(frame).not.toBeNull();
      expect(frame!.moved).toBe(true);
      expect(frame!.scrollTop).toBeGreaterThan(0);
    });

    it('returns null when the container owns no scrollable region', async () => {
      const port = new WidgetTestPort(SCROLLABLE_LIST);
      const plain = port.document.querySelector('#plain')!;

      await expect(
        port.scrollContainer({ path: pathOf(plain, port.document.documentElement) }),
      ).resolves.toBeNull();
    });

    it('dispatches a scroll event on the region so an event-keyed renderer re-mounts', async () => {
      const port = new WidgetTestPort(SCROLLABLE_LIST);
      const panel = port.document.querySelector('#panel')!;
      let events = 0;
      panel.addEventListener('scroll', () => {
        events += 1;
      });

      await port.scrollContainer({ path: pathOf(panel, port.document.documentElement) });

      expect(events).toBe(1);
    });

    it('is counted as one mutation and no read', async () => {
      const port = new WidgetTestPort(SCROLLABLE_LIST);
      const panel = port.document.querySelector('#panel')!;
      const counted = countingPort(port);

      await counted.port.scrollContainer({ path: pathOf(panel, port.document.documentElement) });

      expect(counted.counts.mutations).toBe(1);
      expect(counted.counts.reads).toBe(0);
      expect(counted.counts.byAction.scrollContainer).toBe(1);
    });

    it('is absent from every registered driver detection path', async () => {
      // Detection reads closed state only; a driver that scrolled while
      // deciding whether it applies would mutate the page to answer a question
      // about it. Asserted by counting the operation, because a silent extra
      // page action is invisible in every other signal.
      const port = new WidgetTestPort(SCROLLABLE_LIST);
      const panel = port.document.querySelector('#panel')!;
      const container = { path: pathOf(panel, port.document.documentElement) };
      const target = {
        ref: port.refFor('#panel'),
        role: 'listbox',
        name: 'Rows',
        group: null,
        value: null,
      };
      const counted = countingPort(port);

      for (const driver of DRIVERS) {
        await driver.detect(counted.port, target).catch(() => 0);
        await driver.detectOpen?.(counted.port, target, container).catch(() => 0);
      }

      expect(counted.counts.byAction.scrollContainer).toBeUndefined();
    });
  });

  describe('real Chrome ports', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html><title>Scrollable</title>${SCROLLABLE_LIST}`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
      baseUrl = `http://127.0.0.1:${address.port}/`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    });

    it('scrolls the container, never the window, and clamps at the end', async () => {
      const controller = new AgentBrowserController({
        runId: 'scroll-run',
        browserProvider: new LocalBrowserProvider({
          profileStore: new LocalProfileStore(),
          logger,
        }),
        logger,
      });
      try {
        await controller.navigate(baseUrl);
        const path = await controller.evaluate(() => {
          const panel = document.querySelector('#panel')!;
          const chain: number[] = [];
          let current: Element | null = panel;
          while (current && current !== document.documentElement) {
            const parent: Element | null = current.parentElement;
            if (!parent) break;
            chain.unshift(Array.prototype.indexOf.call(parent.children, current));
            current = parent;
          }
          return chain;
        });

        const first = (await controller.scrollContainer({ path })) as ScrollFrame;
        expect(first.moved).toBe(true);
        // Real geometry, unlike jsdom's zeros — which is exactly why the scan's
        // termination is identity-first and treats these as evidence only.
        expect(first.clientHeight).toBeGreaterThan(0);
        expect(first.scrollHeight).toBeGreaterThan(first.clientHeight);
        // The page is window-scrollable and must not have moved.
        expect(await controller.evaluate(() => window.scrollY)).toBe(0);

        // Run to the end: the assignment clamps, and the step after that
        // reports no movement rather than pretending to advance forever.
        let frame = first;
        for (let step = 0; step < 40 && !frame.atEnd; step += 1) {
          frame = (await controller.scrollContainer({ path })) as ScrollFrame;
        }
        expect(frame.atEnd).toBe(true);
        const beyond = (await controller.scrollContainer({ path })) as ScrollFrame;
        expect(beyond.moved).toBe(false);
        expect(await controller.evaluate(() => window.scrollY)).toBe(0);
      } finally {
        await controller.teardown();
      }
    }, 60_000);
  });

  it('satisfies one shared conformance shape across every port implementation', () => {
    // The contract, not the implementations: each port answers the same
    // question, and a port that grew its own signature would drift the drivers
    // apart from the replay path.
    const shape: (keyof WidgetPort)[] = [
      'observe',
      'click',
      'fill',
      'clear',
      'type',
      'evaluateOn',
      'evaluate',
      'press',
      'scrollContainer',
      'now',
    ];
    const port = new WidgetTestPort(SCROLLABLE_LIST) as unknown as Record<string, unknown>;
    for (const member of shape) expect(typeof port[member]).toBe('function');
    expect(Object.keys(PORT_ACTION_KIND).sort()).toEqual([...shape].sort());
  });
});
