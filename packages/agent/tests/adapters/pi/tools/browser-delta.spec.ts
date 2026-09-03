/**
 * The delta at the tool seam: it ships, it ships once, and it ships nothing new.
 *
 * The controller fake here computes real fingerprints and runs the real
 * `diffFingerprints`, so these tests exercise the wiring rather than a stubbed
 * answer — including the one rule the wiring is easy to get wrong: an internal
 * `observe({ trackDigest: false })` must not become the baseline.
 *
 * Nothing here names a site. The fixtures are roles, accessible names, and
 * URLs on a reserved example host.
 */

import {
  DELTA_MAX_BYTES,
  diffFingerprints,
  fingerprintFromScan,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type AgentInteractable,
  type ObservationFingerprint,
  type PageDelta,
} from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { modelDelta } from '../../../../src/adapters/pi/tools/browser-common.js';
import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import { browserObserveSpec } from '../../../../src/adapters/pi/tools/browser-observe.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps, RunServices } from '../../../../src/runtime/run-services.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import { buildServices } from './test-support.js';

/** One control on a fixture page, in the terms the fingerprint reads. */
interface Control {
  readonly role?: string;
  readonly name: string;
  readonly group?: string | null;
  readonly scope?: 'dialog' | 'page';
  readonly focused?: boolean;
  readonly container?: { readonly role: string; readonly name: string } | null;
  readonly value?: string;
}

/** One page state the fake controller can be standing on. */
interface Frame {
  readonly url?: string;
  readonly title?: string;
  readonly epoch?: string;
  readonly controls: readonly Control[];
}

/**
 * A controller fake that keeps the real baseline rules.
 *
 * `observe`, `beginToolCall` and `deltaSinceBaseline` mirror the production
 * controller exactly — every scan replaces `lastScanFingerprint`, only a
 * model-visible scan replaces `deltaBaseline`, and a tool call pins the
 * baseline it opened on. The delta itself is computed by the real
 * `diffFingerprints`, so a test that passes here is testing the wiring.
 */
class DeltaController {
  public frame: Frame;
  public readonly click = vi.fn();
  public readonly fill = vi.fn();
  public readonly adoptPopup = vi.fn().mockResolvedValue(null);
  public readonly locatorFor = vi.fn().mockResolvedValue([]);
  public observeCount = 0;
  private lastScan: ObservationFingerprint | null = null;
  private baseline: ObservationFingerprint | null = null;
  private callBaseline: ObservationFingerprint | null = null;

  public constructor(frame: Frame) {
    this.frame = frame;
    this.click.mockImplementation(() =>
      Promise.resolve({ url: this.frame.url ?? PAGE, title: this.frame.title ?? 'Page' }),
    );
    this.fill.mockImplementation(() =>
      Promise.resolve({ url: this.frame.url ?? PAGE, title: this.frame.title ?? 'Page' }),
    );
  }

  public navigate(url: string): Promise<{ readonly url: string; readonly title: string }> {
    this.frame = { ...this.frame, url };
    return Promise.resolve({ url, title: this.frame.title ?? 'Page' });
  }

  public observe(
    options: { readonly cap?: number; readonly trackDigest?: boolean } = {},
  ): Promise<AgentBrowserObservation> {
    this.observeCount += 1;
    const fingerprint: ObservationFingerprint = {
      epoch: this.frame.epoch ?? 'y1',
      ...fingerprintFromScan(
        this.frame.url ?? PAGE,
        this.frame.title ?? 'Page',
        this.frame.controls.map(toRaw),
        false,
      ),
    };
    this.lastScan = fingerprint;
    if (options.trackDigest !== false) this.baseline = fingerprint;
    const interactables: AgentInteractable[] = this.frame.controls.map((control, index) => ({
      ref: `e${index + 1}`,
      role: control.role ?? 'button',
      name: control.name,
      ...(control.value === undefined ? {} : { value: control.value }),
    }));
    return Promise.resolve({
      url: this.frame.url ?? PAGE,
      title: this.frame.title ?? 'Page',
      digest: '',
      digestUnchanged: false,
      interactables,
    });
  }

  public beginToolCall(): void {
    this.callBaseline = this.baseline;
  }

  public deltaSinceBaseline(): PageDelta | null {
    if (!this.callBaseline || !this.lastScan) return null;
    return diffFingerprints(this.callBaseline, this.lastScan);
  }

  public describeRef(ref: string): AgentInteractable | undefined {
    const index = Number(ref.slice(1)) - 1;
    const control = this.frame.controls[index];
    return control ? { ref, role: control.role ?? 'button', name: control.name } : undefined;
  }

  public url(): string {
    return this.frame.url ?? PAGE;
  }

  public host(): string {
    return 'example.test';
  }
}

const PAGE = 'https://example.test/';

function toRaw(control: Control): never {
  return {
    role: control.role ?? 'button',
    name: control.name,
    kind: 'button',
    disabled: false,
    top: 0,
    left: 0,
    group: control.group ?? null,
    scope: control.scope ?? 'page',
    value: control.value ?? null,
    valuePresent: false,
    checked: null,
    expanded: null,
    selected: null,
    visible: true,
    elementIndex: 0,
    composedScope: 'document',
    rootNodeDepth: 0,
    focused: control.focused ?? false,
    container: control.container ?? null,
  } as never;
}

function services(
  controller: DeltaController,
  overrides: Partial<BrowserToolDeps> = {},
): RunServices {
  const provenance = new UrlProvenance();
  provenance.record(PAGE);
  provenance.record(`${PAGE}next`);
  return buildServices({
    urlProvenance: provenance,
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

/** Put the model on a frame, the way a `browser_observe` would. */
async function seeded(controller: DeltaController): Promise<void> {
  await controller.observe();
}

describe('@no-llm browser tool page deltas', () => {
  it('returns delta beside observation on a click, not instead of it', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Open preferences' }] });
    await seeded(controller);
    const run = services(controller);
    controller.frame = {
      controls: [
        { name: 'Open preferences' },
        {
          name: 'Close',
          scope: 'dialog',
          container: { role: 'dialog', name: 'Cookie consent' },
        },
      ],
    };

    const result = await wrapTool(browserClickSpec(run), run).execute({ ref: 'e1' }, undefined);

    expect(result.status).toBe('ok');
    const model = JSON.parse(result.modelText) as Record<string, unknown>;
    expect(model.observation).toBeDefined();
    expect(model.delta).toEqual({
      dialogs_opened: [{ role: 'dialog', name: 'Cookie consent' }],
      elements_appeared: {
        count: 1,
        sample: [{ role: 'button', name: 'Close' }],
      },
    });
  });

  it('returns delta beside observation on a navigation', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }], epoch: 'y1' });
    await seeded(controller);
    const run = services(controller);
    controller.frame = { url: `${PAGE}next`, controls: [{ name: 'Arrived' }], epoch: 'y2' };

    const result = await wrapTool(browserNavigateSpec(run), run).execute(
      { url: `${PAGE}next` },
      undefined,
    );

    const model = JSON.parse(result.modelText) as { delta?: PageDelta };
    expect(model.delta?.url_changed).toEqual({ from: PAGE, to: `${PAGE}next` });
    // A new document's controls are not the old document's, so no count is
    // manufactured for them.
    expect(model.delta?.incomplete).toEqual(['document-replaced']);
    expect(model.delta?.elements_appeared).toBeUndefined();
  });

  it('omits the delta entirely on the first navigation of a run and says why', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    const run = services(controller);

    const result = await wrapTool(browserNavigateSpec(run), run).execute(
      { url: `${PAGE}next` },
      undefined,
    );

    expect(result.modelText).not.toContain('"delta"');
    expect(result.details).toMatchObject({ delta_omitted: 'no-baseline' });
  });

  it('returns no delta at all when the action failed', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    await seeded(controller);
    const run = services(controller);
    controller.click.mockRejectedValue(
      Object.assign(new Error('Element ref "e1" is stale.'), { code: 'STALE_ELEMENT_REF' }),
    );

    const result = await wrapTool(browserClickSpec(run), run).execute({ ref: 'e1' }, undefined);

    expect(result.status).toBe('error');
    expect(result.modelText).not.toContain('"delta"');
  });

  it('leaves browser_observe byte-identical to its pre-feature payload', async () => {
    // `browser_observe` is deliberately unchanged in this wave: it is the tool
    // a model reaches for when it wants a read, and adding a delta there would
    // change the very contract the replacement decision has to measure against.
    const controller = new DeltaController({
      controls: [{ role: 'textbox', name: 'Destination', value: 'Dallas' }],
    });
    const run = services(controller);

    const result = await wrapTool(browserObserveSpec(run), run).execute({}, undefined);

    expect(result.modelText).toBe(
      JSON.stringify({
        url: PAGE,
        title: 'Page',
        interactables: [{ ref: 'e1', role: 'textbox', name: 'Destination', value: 'Dallas' }],
      }),
    );
  });

  it('sanitizes an accessible name inside delta exactly as inside observation', async () => {
    const leaky = 'Contact admin@example.com sk-ABCDEF0123456789abcdef01';
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    await seeded(controller);
    const run = services(controller);
    controller.frame = { controls: [{ name: 'Search' }, { name: leaky }] };

    const result = await wrapTool(browserClickSpec(run), run).execute({ ref: 'e1' }, undefined);

    // The delta rides in `model`, so it passes the same `sanitizeAndBound`
    // chokepoint as every other model-visible payload — no second seam.
    expect(result.modelText).not.toContain('admin@example.com');
    expect(result.modelText).not.toContain('sk-ABCDEF0123456789abcdef01');
    const model = JSON.parse(result.modelText) as { delta?: PageDelta };
    const named = model.delta?.elements_appeared?.sample?.[0]?.name ?? '';
    expect(named).toContain('[redacted-');
  });

  it('records the delta and observation byte cost in details', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    await seeded(controller);
    const run = services(controller);
    controller.frame = { controls: [{ name: 'Search' }, { name: 'Results' }] };

    const result = await wrapTool(browserClickSpec(run), run).execute({ ref: 'e1' }, undefined);

    const details = result.details as { delta_bytes?: number; observation_bytes?: number };
    expect(details.delta_bytes).toBeGreaterThan(0);
    expect(details.observation_bytes).toBeGreaterThan(0);
    // The whole point of the block: it is a fraction of the observation it
    // rides beside. Recorded, not claimed — the replacement decision needs
    // total-turn evidence this feature does not have.
    expect(details.delta_bytes!).toBeLessThan(details.observation_bytes!);
  });

  it('records the cost fields on a navigation too, and never past the bound', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    await seeded(controller);
    const run = services(controller);
    controller.frame = {
      url: `${PAGE}next`,
      controls: Array.from({ length: 40 }, (_, index) => ({
        role: 'option',
        name: `Result ${'r'.repeat(100)} ${index}`,
      })),
    };

    const result = await wrapTool(browserNavigateSpec(run), run).execute(
      { url: `${PAGE}next` },
      undefined,
    );

    const details = result.details as { delta_bytes?: number; observation_bytes?: number };
    expect(details.delta_bytes).toBeGreaterThan(0);
    expect(details.observation_bytes).toBeGreaterThan(0);
    expect(details.delta_bytes).toBeLessThanOrEqual(DELTA_MAX_BYTES);
  });

  it('omits delta_bytes exactly when the block itself is omitted', async () => {
    const controller = new DeltaController({ controls: [{ name: 'Search' }] });
    const run = services(controller);

    const result = await wrapTool(browserNavigateSpec(run), run).execute(
      { url: `${PAGE}next` },
      undefined,
    );

    const details = result.details as { delta_bytes?: number; delta_omitted?: string };
    expect(details.delta_bytes).toBeUndefined();
    expect(details.delta_omitted).toBe('no-baseline');
  });

  it('projects no fingerprint field and no identity map into the model payload', () => {
    // `modelDelta` is an explicit allow-list, and this is what the allow-list
    // is for: the private fingerprint holds an identity key for every control
    // on the page, and none of it may reach a payload even if a future field
    // is added to `PageDelta`'s producer.
    const before = frameOf({ controls: [{ name: 'Search' }] });
    const after = frameOf({ controls: [{ name: 'Search' }, { name: 'Results' }] });
    const smuggled = {
      ...diffFingerprints(before, after),
      entries: new Map([['leaked', 1]]),
      containers: new Map(),
      epoch: 'y1',
      focus: 'leaked-focus',
    } as PageDelta;

    const projected = modelDelta(smuggled);

    expect(Object.keys(projected)).toEqual(['elements_appeared']);
    const serialized = JSON.stringify(projected);
    for (const internal of ['entries', 'containers', 'epoch', 'focus', 'entryCount', 'degraded']) {
      expect(serialized).not.toContain(internal);
    }
  });
});

/** A fingerprint for a fixture frame, the way the snapshot builder makes one. */
function frameOf(frame: Frame): ObservationFingerprint {
  return {
    epoch: frame.epoch ?? 'y1',
    ...fingerprintFromScan(
      frame.url ?? PAGE,
      frame.title ?? 'Page',
      frame.controls.map(toRaw),
      false,
    ),
  };
}
