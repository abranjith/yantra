import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AgentBrowserController,
  DeliverableCaptureError,
  StaleElementRefError,
  type AgentDeliverableCapture,
  type DeliverableCaptureBounds,
} from '../../src/browser/agent-controller.js';
import { SetOfMarksError } from '../../src/browser/epoch-guard.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import { puppeteerSetOfMarksPort } from '../../src/browser/set-of-marks.js';
import type { BrowserProvider, Logger } from '../../src/browser/types.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** The production deliverable bounds (FEAT-058 S4). */
const BOUNDS: DeliverableCaptureBounds = { tileWidth: 1920, tileHeight: 4096, maxParts: 6 };

/** The set-of-marks overlay color (`#e11d48`). */
const MARK_RGB = [0xe1, 0x1d, 0x48] as const;

/** A plain block of content, `width` by `height` CSS pixels, with no page margin. */
function block(width: number, height: number): string {
  return (
    `<!doctype html><title>Block</title><style>html,body{margin:0}</style>` +
    `<div style="width:${width}px;height:${height}px;background:#3a7bd5"></div>`
  );
}

/** Synthetic pages; no real site is recreated. */
const PAGES: Readonly<Record<string, string>> = {
  '/viewport':
    '<!doctype html><title>Viewport</title><style>html,body{margin:0}</style>' +
    '<button style="position:absolute;left:20px;top:20px;width:200px;height:80px;' +
    'background:rgb(0,128,0);border:0;color:rgb(0,128,0)">Go</button>',
  '/tall-9000': block(1000, 9000),
  '/tall-30000': block(1000, 30_000),
  '/wide-2500': block(2500, 600),
  '/below-fold':
    '<!doctype html><title>Below</title><style>html,body{margin:0;height:100%}</style>' +
    '<button style="position:absolute;left:40px;top:5000px;width:300px;height:200px;' +
    'background:rgb(0,128,0);border:0;color:rgb(0,128,0)">Below the fold</button>',
};

/** Reads one pixel of an 8-bit, non-interlaced RGB or RGBA PNG. */
function pixelAt(png: Uint8Array, x: number, y: number): readonly [number, number, number] {
  const bytes = Buffer.from(png);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  if (bytes[24] !== 8 || bytes[28] !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('test decoder handles only 8-bit non-interlaced RGB/RGBA PNGs');
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows: Buffer[] = [];
  for (let row = 0; row <= Math.min(y, height - 1); row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    const previous = rows[row - 1];
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous?.[i] ?? 0;
      const upLeft = i >= channels ? (previous?.[i - channels] ?? 0) : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      line[i] = (line[i]! + predictor) & 0xff;
    }
    rows.push(line);
  }
  const start = x * channels;
  const line = rows[y]!;
  return [line[start]!, line[start + 1]!, line[start + 2]!];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function hasPngSignature(png: Uint8Array): boolean {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => png[i] === byte);
}

describe('@no-llm AgentBrowserController.captureDeliverable (real Chrome)', () => {
  let server: Server;
  let baseUrl: string;
  let fixture: MigrationBrowserFixture;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    server = createServer((request, response) => {
      const page = PAGES[request.url ?? ''];
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(page ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.cleanup();
  });

  function provider(): BrowserProvider {
    const actual = new LocalBrowserProvider({ profileStore: new LocalProfileStore(), logger });
    return {
      launch: (options) => actual.launch({ ...options, ...fixture.launchOptions }),
      detectChrome: () => actual.detectChrome(),
    };
  }

  async function withController(
    run: (controller: AgentBrowserController) => Promise<void>,
  ): Promise<void> {
    const controller = new AgentBrowserController({
      runId: 'deliverable-capture',
      browserProvider: provider(),
      logger,
    });
    try {
      await run(controller);
    } finally {
      await controller.teardown();
    }
  }

  function refNamed(
    observation: Awaited<ReturnType<AgentBrowserController['observe']>>,
    name: string,
  ): string {
    const entry = observation.interactables.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`fixture control "${name}" was not observed`);
    return entry.ref;
  }

  function expectPngs(capture: AgentDeliverableCapture): void {
    for (const tile of capture.tiles) expect(hasPngSignature(tile.png)).toBe(true);
  }

  it('captures the viewport as one clean, complete tile at the viewport size', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/viewport`);
      const observation = await controller.observe();
      expect(refNamed(observation, 'Go')).toMatch(/^e\d+$/);
      const view = await controller.evaluate(() => ({ w: innerWidth, h: innerHeight }));

      const capture = await controller.captureDeliverable({ scope: 'viewport', bounds: BOUNDS });

      expect(capture).toMatchObject({ scope: 'viewport', complete: true, labels: [] });
      expect(capture.tiles).toHaveLength(1);
      expect(capture.tiles[0]).toMatchObject({ width: view.w, height: view.h });
      expect(capture.capturedHeight).toBeUndefined();
      expectPngs(capture);
      // A pixel inside the ref'd control is the control's own color, never a mark.
      const sampled = pixelAt(capture.tiles[0]!.png, 60, 60);
      expect(sampled).not.toEqual(MARK_RGB);
      expect(sampled[1]).toBeGreaterThan(100);
      expect(sampled[0]).toBeLessThan(40);
    });
  }, 60_000);

  it('tiles a 9000 px page into 4096, 4096, and 808 px parts', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/tall-9000`);

      const capture = await controller.captureDeliverable({ scope: 'full_page', bounds: BOUNDS });

      expect(capture.tiles.map((tile) => tile.height)).toEqual([4096, 4096, 808]);
      expect(capture).toMatchObject({
        complete: true,
        labels: [],
        capturedHeight: 9000,
        pageHeight: 9000,
      });
      expectPngs(capture);
    });
  }, 90_000);

  it('cuts a 30000 px page after six tiles and labels it truncated', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/tall-30000`);

      const capture = await controller.captureDeliverable({ scope: 'full_page', bounds: BOUNDS });

      expect(capture.tiles).toHaveLength(6);
      expect(capture).toMatchObject({
        complete: false,
        labels: ['truncated'],
        capturedHeight: 24_576,
        pageHeight: 30_000,
      });
    });
  }, 120_000);

  it('clips a 2500 px wide page to 1920 and labels it clipped_width', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/wide-2500`);

      const capture = await controller.captureDeliverable({ scope: 'full_page', bounds: BOUNDS });

      expect(capture).toMatchObject({ complete: false, labels: ['clipped_width'] });
      expect(capture.tiles[0]?.width).toBe(1920);
    });
  }, 60_000);

  it('captures an element below the fold without scrolling, labeled beyond_viewport', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/below-fold`);
      const ref = refNamed(await controller.observe(), 'Below the fold');
      const scrollBefore = await controller.evaluate(() => scrollY);

      const capture = await controller.captureDeliverable({
        scope: 'element',
        ref,
        bounds: BOUNDS,
      });

      expect(capture).toMatchObject({
        scope: 'element',
        ref,
        complete: true,
        labels: ['beyond_viewport'],
        capturedHeight: 200,
      });
      expect(capture.tiles).toHaveLength(1);
      expect(capture.tiles[0]).toMatchObject({ width: 300, height: 200 });
      expect(await controller.evaluate(() => scrollY)).toBe(scrollBefore);
      const sampled = pixelAt(capture.tiles[0]!.png, 150, 100);
      expect(sampled[1]).toBeGreaterThan(100);
      expect(sampled[0]).toBeLessThan(40);
    });
  }, 60_000);

  it('rejects a stale ref with StaleElementRefError', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/viewport`);
      await controller.observe();

      await expect(
        controller.captureDeliverable({ scope: 'element', ref: 'e9999', bounds: BOUNDS }),
      ).rejects.toBeInstanceOf(StaleElementRefError);
    });
  }, 60_000);

  it('refuses while the set-of-marks overlay is in the document', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/viewport`);
      const page = (controller as unknown as { page: Page }).page;
      await puppeteerSetOfMarksPort(page).inject([
        { ref: 'e1', left: 10, top: 10, width: 50, height: 50 },
      ]);

      const result = controller.captureDeliverable({ scope: 'viewport', bounds: BOUNDS });

      await expect(result).rejects.toBeInstanceOf(DeliverableCaptureError);
      await expect(result).rejects.toMatchObject({ code: 'overlay-present' });
    });
  }, 60_000);

  it('keeps tiles in CSS pixels under a device scale factor of 2', async () => {
    await withController(async (controller) => {
      await controller.navigate(`${baseUrl}/viewport`);
      const page = (controller as unknown as { page: Page }).page;
      const view = await controller.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      await page.setViewport({ width: view.w, height: view.h, deviceScaleFactor: 2 });

      const capture = await controller.captureDeliverable({
        scope: 'viewport',
        bounds: { tileWidth: view.w, tileHeight: view.h, maxParts: 6 },
      });

      expect(capture.tiles[0]).toMatchObject({ width: view.w, height: view.h });
    });
  }, 60_000);
});

/** A solid `size` by `size` RGB PNG, encoded here so no image library is needed. */
function solidPng(size: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lr6fWQAAAABJRU5ErkJggg==';

/** A controller over a fake page whose CDP session can move the epoch mid-capture. */
function harness(options: { readonly bumpEpochOnTile?: number; readonly contentHeight?: number }) {
  const internals = { epoch: 7 };
  let tiles = 0;
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { width: 800, height: options.contentHeight ?? 9000 } };
      }
      tiles += 1;
      if (tiles === options.bumpEpochOnTile) internals.epoch += 1;
      return { data: ONE_PIXEL_PNG };
    }),
    detach: vi.fn(async () => undefined),
  };
  const page = {
    evaluate: vi.fn(async (_fn: unknown, ...args: unknown[]) =>
      args.length === 0 ? { left: 0, top: 0, width: 800, height: 600 } : false,
    ),
    createCDPSession: vi.fn(async () => cdp),
  };
  const controller = new AgentBrowserController({
    runId: 'deliverable-harness',
    browserProvider: {} as never,
  });
  const fields = controller as unknown as {
    session: object;
    pageFacade: object;
    page: unknown;
    settler: { readonly epoch: number };
  };
  fields.session = {};
  fields.pageFacade = {};
  fields.page = page;
  fields.settler = {
    get epoch() {
      return internals.epoch;
    },
  };
  return { controller, cdp };
}

describe('@no-llm captureDeliverable epoch and session handling', () => {
  it('returns no tiles when the document changes between tiles, and detaches the session', async () => {
    const { controller, cdp } = harness({ bumpEpochOnTile: 2 });

    const result = controller.captureDeliverable({ scope: 'full_page', bounds: BOUNDS });

    await expect(result).rejects.toBeInstanceOf(SetOfMarksError);
    await expect(result).rejects.toMatchObject({ code: 'SET_OF_MARKS_EPOCH_CHANGED' });
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });

  it('captures every tile through one page-scoped session', async () => {
    const { controller, cdp } = harness({ contentHeight: 9000 });

    const capture = await controller.captureDeliverable({
      scope: 'full_page',
      bounds: { tileWidth: 1920, tileHeight: 4096, maxParts: 6 },
    });

    expect(capture.tiles).toHaveLength(3);
    const clips = cdp.send.mock.calls
      .filter(([method]) => method === 'Page.captureScreenshot')
      .map((call) => (call as unknown as [string, { clip: unknown }])[1].clip);
    expect(clips).toEqual([
      { x: 0, y: 0, width: 800, height: 4096, scale: 1 },
      { x: 0, y: 4096, width: 800, height: 4096, scale: 1 },
      { x: 0, y: 8192, width: 800, height: 808, scale: 1 },
    ]);
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });

  it('detaches the session when a screenshot call fails', async () => {
    const { controller, cdp } = harness({});
    const failure = new Error('transport failed');
    cdp.send.mockImplementation(async () => {
      throw failure;
    });

    await expect(controller.captureDeliverable({ scope: 'viewport', bounds: BOUNDS })).rejects.toBe(
      failure,
    );
    expect(cdp.detach).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a decoded tile is larger than the bounds (a scaled surface)', async () => {
    const { controller, cdp } = harness({});
    cdp.send.mockImplementation(async () => ({ data: solidPng(4) }));

    const result = controller.captureDeliverable({
      scope: 'viewport',
      bounds: { tileWidth: 2, tileHeight: 2, maxParts: 6 },
    });

    await expect(result).rejects.toBeInstanceOf(DeliverableCaptureError);
    await expect(result).rejects.toMatchObject({ code: 'bounds-exceeded' });
  });

  it('clips the viewport capture to the current scroll offset', async () => {
    const { controller, cdp } = harness({});
    const page = (controller as unknown as { page: { evaluate: ReturnType<typeof vi.fn> } }).page;
    page.evaluate.mockImplementation(async (_fn: unknown, ...args: unknown[]) =>
      args.length === 0 ? { left: 0, top: 1500, width: 800, height: 600 } : false,
    );

    await controller.captureDeliverable({ scope: 'viewport', bounds: BOUNDS });

    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 1500, width: 800, height: 600, scale: 1 },
    });
  });
});
