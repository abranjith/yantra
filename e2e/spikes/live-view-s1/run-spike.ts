/**
 * Spike S1 (FEAT-069 TASK-001): glass and readability over a live screencast.
 *
 * A **source** headless Chrome renders a fixture page with continuous motion
 * and dense text and streams it with CDP `Page.startScreencast` (JPEG). The
 * harness paces acks to the target rate, keeps a one-slot latest-wins frame
 * queue (plan §6) and relays frames over a local WebSocket to a **viewer**
 * Chrome that draws them on a canvas under four glass panels using the
 * shipped FEAT-061 scrim floor. For each combination it records frame
 * intervals, both main-thread shares and JPEG sizes.
 *
 * Throwaway evidence, not product code; not run by `pnpm test`. Vitest-free
 * (memory). Needs built packages: `pnpm exec turbo run build --filter=@yantra/ui --filter=@yantra/core`.
 *
 *   npx tsx e2e/spikes/live-view-s1/run-spike.ts [--duration 30] [--out results.json]
 *     [--only glass|solid] [--chrome <path>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { detectChrome } from '@yantra/core';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  byteStats,
  framesPerSecond,
  glassContrastTable,
  intervals,
  mainThreadShare,
  percentile,
  renderContrastTable,
  renderResultTable,
  viewerGlass,
  type SpikeResultRow,
  type TaskSample,
} from './metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1600, height: 1000 } as const;
const WARMUP_MS = 3_000;

interface Combination {
  readonly surfaces: 'glass' | 'solid';
  readonly targetFps: number;
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** A page with continuous motion and dense text, the worst realistic case for JPEG and blur. */
const MOTION_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/1.35 Georgia,serif;background:#fafafa;color:#222;overflow:hidden}
.hero{height:260px;background:linear-gradient(90deg,#f06,#48f,#0c8,#fc0,#f06);background-size:400% 100%;animation:slide 4s linear infinite}
@keyframes slide{to{background-position:400% 0}}
.spin{position:absolute;top:60px;width:120px;height:120px;border-radius:16px;background:#222;animation:spin 2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.cols{columns:5;padding:12px 20px;gap:24px}
.ticker{position:absolute;bottom:0;left:0;right:0;height:40px;background:#111;color:#0f0;font:20px monospace;white-space:nowrap;overflow:hidden}
.ticker span{display:inline-block;animation:tick 8s linear infinite}
@keyframes tick{from{transform:translateX(100%)}to{transform:translateX(-100%)}}
</style></head><body>
<div class="hero"></div>
<div class="spin" style="left:120px"></div><div class="spin" style="left:520px;animation-duration:3s"></div><div class="spin" style="left:920px;animation-duration:1.4s"></div>
<div class="cols" id="cols"></div>
<div class="ticker"><span id="tick"></span></div>
<script>
const words='lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
let text='';for(let i=0;i<2600;i++){text+=words[(i*7)%words.length]+(i%13===0?'. ':' ');}
document.getElementById('cols').textContent=text;
let n=0;setInterval(()=>{document.getElementById('tick').textContent='LIVE '+(n++)+' · prices 101.2 99.8 103.4 · '+new Date().toISOString();},50);
</script></body></html>`;

function combinations(only: string | undefined): Combination[] {
  const out: Combination[] = [];
  for (const targetFps of [5, 10]) {
    for (const quality of [50, 70]) {
      for (const [maxWidth, maxHeight] of [
        [1280, 800],
        [1600, 1000],
      ] as const) {
        out.push({ surfaces: 'glass', targetFps, quality, maxWidth, maxHeight });
      }
    }
  }
  // Solid is the fallback: measure it at the heaviest glass combination and the default.
  out.push({ surfaces: 'solid', targetFps: 10, quality: 70, maxWidth: 1600, maxHeight: 1000 });
  out.push({ surfaces: 'solid', targetFps: 5, quality: 70, maxWidth: 1280, maxHeight: 800 });
  return only === undefined ? out : out.filter((combo) => combo.surfaces === only);
}

async function sample(session: CDPSession): Promise<TaskSample> {
  const { metrics } = await session.send('Performance.getMetrics');
  const read = (name: string): number => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { taskDuration: read('TaskDuration'), timestamp: read('Timestamp') };
}

/** The relay: one slot, latest wins, one frame in flight per viewer until it acks (plan §6). */
class Relay {
  private socket: WebSocket | null = null;
  private slot: Buffer | null = null;
  private inFlight = false;
  public replaced = 0;
  public readonly sizes: number[] = [];

  public attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on('message', (data, isBinary) => {
      if (!isBinary && Buffer.isBuffer(data) && data.toString('utf8') === 'ack') {
        this.inFlight = false;
        this.pump();
      }
    });
  }

  public offer(jpeg: Buffer): void {
    this.sizes.push(jpeg.length);
    if (this.slot !== null) this.replaced += 1;
    this.slot = jpeg;
    this.pump();
  }

  public reset(): void {
    this.replaced = 0;
    this.sizes.length = 0;
  }

  private pump(): void {
    if (this.inFlight || this.slot === null || this.socket === null) return;
    const next = this.slot;
    this.slot = null;
    this.inFlight = true;
    this.socket.send(next, { binary: true });
  }
}

async function startServer(relay: Relay): Promise<{ server: Server; port: number }> {
  const viewerHtml = await readFile(join(HERE, 'viewer.html'), 'utf8');
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body =
      path === '/viewer.html' ? viewerHtml : path === '/motion.html' ? MOTION_PAGE : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    relay.attach(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function launch(executablePath: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { ...VIEWPORT, deviceScaleFactor: 1 },
    args: ['--force-color-profile=srgb', '--hide-scrollbars'],
  });
}

async function measure(
  combo: Combination,
  durationMs: number,
  browsers: { source: Browser; viewer: Browser },
  port: number,
  relay: Relay,
): Promise<SpikeResultRow> {
  const source = await browsers.source.newPage();
  await source.goto(`http://127.0.0.1:${port}/motion.html`);
  const viewer: Page = await browsers.viewer.newPage();
  const glass = encodeURIComponent(JSON.stringify(viewerGlass('light')));
  await viewer.goto(
    `http://127.0.0.1:${port}/viewer.html?ws=ws://127.0.0.1:${port}/&surfaces=${combo.surfaces}&glass=${glass}`,
  );

  const sourceCdp = await source.createCDPSession();
  const viewerCdp = await viewer.createCDPSession();
  await sourceCdp.send('Performance.enable');
  await viewerCdp.send('Performance.enable');

  // Ack pacing: Chrome keeps a small number of unacked frames in flight (two
  // in practice), so each ack is scheduled one interval after the previous
  // *scheduled* ack. Pacing from the last sent ack lets both in-flight frames
  // be acked together and doubles the rate (first measurement: 27 fps at a
  // 10 fps target).
  const minInterval = 1000 / combo.targetFps;
  let nextAckAt = 0;
  sourceCdp.on('Page.screencastFrame', (event) => {
    relay.offer(Buffer.from(event.data, 'base64'));
    const now = performance.now();
    nextAckAt = Math.max(now, nextAckAt + minInterval);
    setTimeout(() => {
      sourceCdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {
        // The stream ended between the frame and its ack.
      });
    }, nextAckAt - now);
  });
  await sourceCdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: combo.quality,
    maxWidth: combo.maxWidth,
    maxHeight: combo.maxHeight,
    everyNthFrame: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
  relay.reset();
  await viewer.evaluate(() => {
    const spike = (
      window as unknown as { __spike: { draws: number[]; rafs: number[]; decodeMs: number[] } }
    ).__spike;
    spike.draws.length = 0;
    spike.rafs.length = 0;
    spike.decodeMs.length = 0;
  });
  const viewerBefore = await sample(viewerCdp);
  const sourceBefore = await sample(sourceCdp);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const viewerAfter = await sample(viewerCdp);
  const sourceAfter = await sample(sourceCdp);
  const draws = await viewer.evaluate(() =>
    (window as unknown as { __spike: { draws: number[] } }).__spike.draws.slice(),
  );

  await sourceCdp.send('Page.stopScreencast');
  await sourceCdp.detach();
  await viewerCdp.detach();
  await source.close();
  await viewer.close();

  const gaps = intervals(draws);
  const bytes = byteStats(relay.sizes);
  return {
    ...combo,
    drawnFps: framesPerSecond(draws),
    intervalP50: percentile(gaps, 50),
    intervalP95: percentile(gaps, 95),
    viewerShare: mainThreadShare(viewerBefore, viewerAfter),
    sourceShare: mainThreadShare(sourceBefore, sourceAfter),
    meanBytes: bytes.mean,
    maxBytes: bytes.max,
    framesDrawn: draws.length,
    framesReplaced: relay.replaced,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      duration: { type: 'string', default: '30' },
      out: { type: 'string' },
      only: { type: 'string' },
      chrome: { type: 'string' },
    },
  });
  const durationMs = Number(values.duration) * 1000;
  const chromePath = values.chrome ?? detectChrome()?.path;
  if (chromePath === undefined) {
    throw new Error(
      'Spike S1 needs a local Chrome. Install Chrome stable or pass --chrome <path>.',
    );
  }

  const relay = new Relay();
  const { server, port } = await startServer(relay);
  const source = await launch(chromePath);
  const viewer = await launch(chromePath);
  const rows: SpikeResultRow[] = [];
  try {
    for (const combo of combinations(values.only)) {
      process.stderr.write(
        `measuring ${combo.surfaces} ${combo.targetFps} fps q${combo.quality} ${combo.maxWidth}x${combo.maxHeight}…\n`,
      );
      rows.push(await measure(combo, durationMs, { source, viewer }, port, relay));
    }
  } finally {
    await source.close();
    await viewer.close();
    server.close();
  }

  const environment = {
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} logical cores)`,
    chrome: await (async () => {
      const probe = await launch(chromePath);
      const version = await probe.version();
      await probe.close();
      return version;
    })(),
    node: process.version,
    durationSeconds: durationMs / 1000,
  };
  const contrast = glassContrastTable();
  const markdown = [
    `Environment: ${environment.os}; ${environment.cpu}; ${environment.chrome}; Node ${environment.node}; ${environment.durationSeconds} s per combination.`,
    '',
    renderResultTable(rows),
    '',
    renderContrastTable(contrast),
  ].join('\n');
  process.stdout.write(`${markdown}\n`);
  if (values.out !== undefined) {
    await writeFile(values.out, JSON.stringify({ environment, rows, contrast }, null, 2));
  }
}

await main();
