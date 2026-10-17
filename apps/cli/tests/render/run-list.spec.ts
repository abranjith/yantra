import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { JSONRenderer } from '../../src/render/json.js';
import { TerminalRenderer } from '../../src/render/terminal.js';
import type { ConnectorRenderOpts, ListItem } from '../../src/render/types.js';

function capture(): { readonly opts: ConnectorRenderOpts; readonly value: () => string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return {
    opts: { json: false, debug: false, noColor: true, stream, errStream: stream },
    value: () => data,
  };
}

const NEW_RUN: ListItem = {
  kind: 'run',
  runId: '20261015T120000Z-do-0000aaaa',
  workflowName: 'fill the test form',
  status: 'failed',
  startedAt: '2026-10-15T12:00:00.000Z',
  durationMs: 784000,
  taskOutcome: 'partial',
};
const OLD_RUN: ListItem = {
  kind: 'run',
  runId: '20261014T023539Z-do-7039cbaa',
  workflowName: 'fill the form',
  status: 'completed',
  startedAt: '2026-10-14T02:35:39.000Z',
  durationMs: 784000,
};

describe('@no-llm run listings show the outcome word (FEAT-054)', () => {
  it('shows the word beside the status for a new run and nothing extra for an old one', () => {
    const out = capture();
    new TerminalRenderer().renderList([NEW_RUN, OLD_RUN], out.opts);
    const line = (id: string, status: string, workflow: string): string =>
      `${id.padEnd(48)}  ${status.padEnd(10)}  ${'784000ms'.padStart(8)}  workflow=${workflow}`;
    expect(out.value()).toBe(
      `${line(NEW_RUN.runId, 'failed partial', 'fill the test form')}\n` +
        `${line(OLD_RUN.runId, 'completed', 'fill the form')}\n`,
    );
  });

  it('carries taskOutcome in JSON only when the run recorded one', () => {
    const out = capture();
    new JSONRenderer().renderList([NEW_RUN, OLD_RUN], { ...out.opts, json: true });
    const parsed = JSON.parse(out.value()) as { items: Record<string, unknown>[] };
    expect(parsed.items[0]).toMatchObject({ taskOutcome: 'partial' });
    expect('taskOutcome' in parsed.items[1]!).toBe(false);
  });
});
