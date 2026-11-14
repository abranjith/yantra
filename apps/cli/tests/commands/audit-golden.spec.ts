// @no-llm
/**
 * `yantra audit` output is byte-identical across the FEAT-066 builder rewrite
 * (streaming JSONL, windows, cache). The goldens under
 * `__goldens__/audit/` were captured from the pre-FEAT-066 builder on these
 * fixtures; recapture deliberately with `YANTRA_CAPTURE_AUDIT_GOLDENS=1`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  writeRichAgentRun,
  writeScheduledWorkflowRun,
  writeStartupFailureRun,
} from '@yantra/test-helpers/run-dirs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAuditReport } from '../../src/commands/audit-builder.js';
import { JSONRenderer } from '../../src/render/json.js';
import { TerminalRenderer } from '../../src/render/terminal.js';

const GOLDENS = join(import.meta.dirname, '__goldens__', 'audit');
const CAPTURE = process.env.YANTRA_CAPTURE_AUDIT_GOLDENS === '1';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-audit-golden-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function golden(name: string, actual: string): string {
  const path = join(GOLDENS, name);
  if (CAPTURE) {
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(path, actual);
    return actual;
  }
  if (!existsSync(path)) throw new Error(`Missing golden ${name}`);
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

async function rendered(runId: string, dir: string, json: boolean): Promise<string> {
  const result = await buildAuditReport(runId, dir);
  if (result.kind !== 'ok') throw new Error(result.error.message);
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  const renderer = json ? new JSONRenderer() : new TerminalRenderer();
  renderer.renderAudit(result.report, {
    json,
    debug: false,
    noColor: true,
    stream,
    errStream: stream,
  });
  return text;
}

describe('yantra audit output is unchanged', () => {
  it.each([
    ['rich-agent', 'agent-run', writeRichAgentRun],
    ['scheduled-workflow', 'wf-run', writeScheduledWorkflowRun],
    ['startup-failure', 'fail-run', writeStartupFailureRun],
  ] as const)('%s', async (name, runId, write) => {
    const dir = await write(join(root, name));

    const json = await rendered(runId, dir, true);
    const terminal = await rendered(runId, dir, false);

    expect(json).toBe(golden(`${name}.json`, json));
    expect(terminal).toBe(golden(`${name}.txt`, terminal));
  });
});
