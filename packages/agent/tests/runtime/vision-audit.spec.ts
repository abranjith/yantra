import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { MarkdownReportBuilder } from '@yantra/core';
import { ToolAuditEntry } from '@yantra/protocol';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentSession } from '../../src/provider/types.js';
import { RunRecorder } from '../../src/runtime/index.js';

interface EmittingSession extends AgentSession {
  emit(event: Parameters<Parameters<AgentSession['subscribe']>[0]>[0]): void;
}

function makeSession(runDir: string): EmittingSession {
  const listeners = new Set<Parameters<AgentSession['subscribe']>[0]>();
  return {
    id: 'vision-session',
    logPath: join(runDir, 'agent', 'vision-session.jsonl'),
    authSource: 'managed',
    run: async () => ({ outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    abort: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

describe('@no-llm vision audit projection', () => {
  let root: string;
  let runDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-vision-audit-'));
    runDir = join(root, 'run-vision');
    await mkdir(join(runDir, 'agent'), { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        runId: 'run-vision',
        taskId: 'task-vision',
        workflowName: 'do',
        workflowVersion: null,
        params: {},
        startedAt: '2026-09-03T12:00:00.000Z',
        status: 'running',
        profileKind: 'ephemeral',
        cookieProfilePath: null,
        outputBindingNames: [],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records three captures as metadata without persisting image bytes in stable audit JSONL', async () => {
    const session = makeSession(runDir);
    const logChunks: Buffer[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const recorder = await RunRecorder.open({
      runId: 'run-vision',
      runDir,
      session,
      model: { provider: 'anthropic', id: 'vision-model' },
      systemPrompt: 'vision prompt',
      tools: [],
      sdkVersion: '0.80.6',
      logger: pino({ level: 'info' }, logStream),
    });
    const pngBytes = Buffer.from('\u0089PNG\r\n\u001a\nprivate-pixel-payload', 'latin1');
    const base64 = pngBytes.toString('base64');
    await writeFile(
      session.logPath,
      `${JSON.stringify({ type: 'image', data: base64, mimeType: 'image/png' })}\n`,
      'utf8',
    );

    for (let index = 1; index <= 3; index += 1) {
      const callId = `capture-${index}`;
      const capture = {
        path: `screenshots/${index}-abcdef.png`,
        sha256: 'a'.repeat(64),
        mime_type: 'image/png' as const,
        width: 800,
        height: 600,
        bytes: pngBytes.byteLength,
      };
      session.emit({
        type: 'tool_started',
        callId,
        tool: 'browser_screenshot',
        input: {},
        at: `2026-09-03T12:00:0${index}.000Z`,
      });
      session.emit({
        type: 'tool_finished',
        callId,
        tool: 'browser_screenshot',
        output: {
          status: 'ok',
          details: { captures: [capture] },
          captures: [capture],
          content: [
            { type: 'text', text: `Capture ${index}` },
            { type: 'image', data: base64, mimeType: 'image/png' },
          ],
        },
        isError: false,
        at: `2026-09-03T12:00:0${index}.100Z`,
      });
    }
    await recorder.close();
    const report = await new MarkdownReportBuilder().build(runDir, 'completed');

    const stableText = await readFile(join(runDir, 'tool-calls.jsonl'), 'utf8');
    const pinoText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(logChunks));
    const entries = stableText
      .trim()
      .split(/\r?\n/u)
      .map((line) => ToolAuditEntry.parse(JSON.parse(line) as unknown));
    const ends = entries.filter((entry) => entry.phase === 'end');
    expect(ends).toHaveLength(3);
    expect(ends.every((entry) => entry.captures?.[0]?.bytes === pngBytes.byteLength)).toBe(true);
    expect(ends[0]?.captures?.[0]).toEqual({
      path: 'screenshots/1-abcdef.png',
      sha256: 'a'.repeat(64),
      mime_type: 'image/png',
      width: 800,
      height: 600,
      bytes: pngBytes.byteLength,
    });
    expect(stableText).not.toContain(base64);
    expect(stableText).not.toContain('data:image/');
    expect(Buffer.from(stableText, 'utf8').includes(pngBytes)).toBe(false);
    expect(pinoText).toContain('screenshots/1-abcdef.png');
    expect(pinoText).not.toContain(base64);
    expect(pinoText).not.toContain('data:image/');
    expect(Buffer.from(pinoText, 'utf8').includes(pngBytes)).toBe(false);
    expect(report).toContain('screenshots/1-abcdef.png');
    expect(report).not.toContain(base64);
    expect(report).not.toContain('data:image/');
    expect(Buffer.from(report, 'utf8').includes(pngBytes)).toBe(false);
    await expect(readFile(session.logPath, 'utf8')).resolves.toContain(base64);
  });

  it('keeps legacy audit entries without captures schema-valid', () => {
    expect(
      ToolAuditEntry.safeParse({
        ts: '2026-09-03T12:00:00.000Z',
        seq: 0,
        run_id: 'legacy-run',
        session_id: 'legacy-session',
        call_id: 'legacy-call',
        tool: 'status',
        phase: 'end',
        input_sanitized: null,
        output_sanitized: { status: 'ok' },
        status: 'ok',
        duration_ms: 1,
        error_code: null,
        confirmation_id: null,
      }).success,
    ).toBe(true);
  });
});
