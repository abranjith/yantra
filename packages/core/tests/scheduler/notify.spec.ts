import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SinkNotifier,
  buildNotification,
  desktopCommand,
  type Notification,
  type SpawnFn,
} from '../../src/scheduler/notify.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A fake child process that resolves with the given exit code. */
function fakeChild(code: number, emitError = false): EventEmitter {
  const ee = new EventEmitter();
  setImmediate(() => {
    if (emitError) {
      ee.emit('error', new Error('spawn failed'));
    } else {
      ee.emit('exit', code);
    }
  });
  return ee;
}

describe('@no-llm buildNotification', () => {
  it('builds a completed notification with a secret-free body', () => {
    const n = buildNotification(
      { scheduleId: 'S1', runId: 'r1', workflowName: 'weekly-report', kind: 'completed' },
      new Date('2026-07-05T00:00:00.000Z'),
    );
    expect(n).toMatchObject({
      schedule_id: 'S1',
      run_id: 'r1',
      kind: 'completed',
      created_at: '2026-07-05T00:00:00.000Z',
    });
    expect(n.title).toContain('weekly-report');
  });

  it('embeds the confirm command in a confirmation_needed body', () => {
    const n = buildNotification({
      scheduleId: 'S1',
      runId: 'r1',
      workflowName: 'checkout',
      kind: 'confirmation_needed',
      confirmCommand: 'yantra confirm r1 grant',
    });
    expect(n.body).toContain('yantra confirm r1 grant');
  });
});

describe('@no-llm SinkNotifier', () => {
  let dir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yantra-notify-'));
    jsonlPath = join(dir, 'notifications.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('always writes the durable jsonl record, regardless of target', async () => {
    const notifier = new SinkNotifier({ jsonlPath, platform: 'linux', logger: silentLogger });
    const n = buildNotification({
      scheduleId: 'S1',
      runId: 'r1',
      workflowName: 'demo',
      kind: 'completed',
    });
    await notifier.notify(n, 'none');

    const content = await readFile(jsonlPath, 'utf8');
    const parsed = JSON.parse(content.trim()) as Notification;
    expect(parsed.id).toBe(n.id);
    expect(parsed.kind).toBe('completed');
  });

  it('appends multiple notifications as separate jsonl lines', async () => {
    const notifier = new SinkNotifier({ jsonlPath, platform: 'linux' });
    await notifier.notify(
      buildNotification({ scheduleId: 'S', runId: '1', workflowName: 'a', kind: 'completed' }),
      'file',
    );
    await notifier.notify(
      buildNotification({ scheduleId: 'S', runId: '2', workflowName: 'a', kind: 'failed' }),
      'file',
    );
    const lines = (await readFile(jsonlPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => JSON.parse(l))).toBe(true);
  });

  it('spawns the platform toast for a desktop target and records success', async () => {
    const spawnFn = vi.fn(() => fakeChild(0)) as unknown as SpawnFn;
    const notifier = new SinkNotifier({ jsonlPath, platform: 'darwin', spawnFn });
    const n = buildNotification({
      scheduleId: 'S',
      runId: 'r',
      workflowName: 'demo',
      kind: 'completed',
    });
    await notifier.notify(n, 'desktop');

    expect(spawnFn).toHaveBeenCalledTimes(1);
    // Still wrote the durable record.
    const content = await readFile(jsonlPath, 'utf8');
    expect(content).toContain(n.id);
  });

  it('degrades to file (with a warn) when the desktop toast spawn errors', async () => {
    const warn = vi.fn();
    const spawnFn = vi.fn(() => fakeChild(1, true)) as unknown as SpawnFn;
    const notifier = new SinkNotifier({
      jsonlPath,
      platform: 'darwin',
      spawnFn,
      logger: { ...silentLogger, warn },
    });
    const n = buildNotification({
      scheduleId: 'S',
      runId: 'r',
      workflowName: 'demo',
      kind: 'completed',
    });
    await notifier.notify(n, 'desktop');

    expect(warn).toHaveBeenCalled();
    const content = await readFile(jsonlPath, 'utf8');
    expect(content).toContain(n.id); // durable record still present
  });
});

describe('@no-llm desktopCommand', () => {
  const n: Notification = {
    id: 'N1',
    schedule_id: 'S',
    run_id: 'r',
    kind: 'completed',
    title: 'Yantra: "demo" completed',
    body: 'Scheduled run finished.',
    created_at: '2026-07-05T00:00:00.000Z',
  };

  it('uses osascript on darwin', () => {
    const cmd = desktopCommand('darwin', n);
    expect(cmd?.file).toBe('osascript');
  });

  it('uses notify-send on linux', () => {
    const cmd = desktopCommand('linux', n);
    expect(cmd?.file).toBe('notify-send');
  });

  it('uses powershell on win32', () => {
    const cmd = desktopCommand('win32', n);
    expect(cmd?.file).toBe('powershell');
  });

  it('returns null on an unsupported platform', () => {
    expect(desktopCommand('aix', n)).toBeNull();
  });

  it('strips quotes/newlines so titles cannot break out of the command', () => {
    const malicious: Notification = {
      ...n,
      title: 'evil"; rm -rf /\n#',
      body: "body' with `backticks`",
    };
    const cmd = desktopCommand('darwin', malicious);
    const joined = (cmd?.args ?? []).join(' ');
    expect(joined).not.toContain('"; rm');
    expect(joined).not.toContain('`');
  });
});
