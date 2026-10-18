/** @no-llm FEAT-058 TASK-007: saved captures in the published Brief. */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultSanitizer } from '@yantra/core';
import { Brief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBriefPublisher,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { ActionLedger } from '../../../../src/runtime/action-ledger.js';
import { briefArtifactsFrom } from '../../../../src/runtime/brief-composer.js';
import type { CaptureArtifactSet } from '../../../../src/runtime/capture-artifacts.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import {
  TaskContractStore,
  normalizeContract,
  type TaskContractParams,
} from '../../../../src/runtime/task-contract.js';

import { buildServices } from './test-support.js';

const SHA = 'cd'.repeat(32);

function captureSet(seq: number, parts: number, extra: Partial<CaptureArtifactSet> = {}) {
  return {
    scope: parts > 1 ? ('full_page' as const) : ('viewport' as const),
    parts: Array.from({ length: parts }, (_, index) => ({
      path: `screenshots/capture-${seq}-${SHA.slice(0, 12)}${parts > 1 ? `-p${index + 1}` : ''}.png`,
      sha256: SHA,
      bytes: 500,
      width: 1280,
      height: parts > 1 ? 4096 : 720,
      part: index + 1,
    })),
    complete: true,
    labels: [],
    ...extra,
  } satisfies CaptureArtifactSet;
}

function newLedger(): ActionLedger {
  return new ActionLedger({
    nowIso: () => '2026-10-16T12:00:00.000Z',
    locate: () => ({ epoch: 1, host: 'forms.example.test' }),
    sanitizer: new DefaultSanitizer(),
  });
}

function recordSet(ledger: ActionLedger, set: CaptureArtifactSet): void {
  ledger.record({
    kind: 'capture',
    scope: set.scope,
    path: set.parts[0]!.path,
    sha256: set.parts[0]!.sha256,
    bytes: set.parts.reduce((sum, part) => sum + part.bytes, 0),
    producer: 'browser_capture',
    parts: set.parts.length,
    complete: set.complete,
    captureSet: set,
  });
}

describe('@no-llm briefArtifactsFrom', () => {
  it('lists one entry per file, in capture order', () => {
    const ledger = newLedger();
    recordSet(ledger, captureSet(1, 1));
    recordSet(ledger, captureSet(2, 3));

    const { artifacts, notice } = briefArtifactsFrom(ledger.entries());

    expect(artifacts.map((entry) => [entry.part, entry.parts, entry.scope])).toEqual([
      [1, 1, 'viewport'],
      [1, 3, 'full_page'],
      [2, 3, 'full_page'],
      [3, 3, 'full_page'],
    ]);
    expect(notice).toBeNull();
  });

  it('caps 14 files at 12 and adds one notice naming the rest', () => {
    const ledger = newLedger();
    recordSet(ledger, captureSet(1, 6));
    recordSet(ledger, captureSet(2, 6));
    recordSet(ledger, captureSet(3, 2));

    const { artifacts, notice } = briefArtifactsFrom(ledger.entries());

    expect(artifacts).toHaveLength(12);
    expect(notice).toEqual({
      kind: 'other',
      source: 'captures',
      reason: "2 further capture files are in the run's screenshots folder.",
    });
  });

  it('never lists a Vision Assist image', () => {
    const ledger = newLedger();
    ledger.record({
      kind: 'capture',
      scope: 'viewport',
      path: `screenshots/1-${SHA.slice(0, 12)}.png`,
      sha256: SHA,
      bytes: 10,
      producer: 'browser_screenshot',
    });

    expect(briefArtifactsFrom(ledger.entries())).toEqual({ artifacts: [], notice: null });
  });

  it('carries completeness and labels onto every part', () => {
    const ledger = newLedger();
    recordSet(ledger, captureSet(1, 2, { complete: false, labels: ['truncated'] }));

    const { artifacts } = briefArtifactsFrom(ledger.entries());

    expect(artifacts.every((entry) => !entry.complete)).toBe(true);
    expect(artifacts.every((entry) => entry.labels.join() === 'truncated')).toBe(true);
  });
});

describe('@no-llm result_publish writes saved captures into the Brief', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-brief-artifacts-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const ACTIONS: TaskContractParams = {
    deliverable: 'actions',
    subject: 'the sign-up form',
    artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
  };

  async function publish(command: 'do' | 'research', sets: readonly CaptureArtifactSet[]) {
    const contract = new TaskContractStore({ runId: 'r', runDir, command, required: true });
    const declared: TaskContractParams =
      command === 'do' ? ACTIONS : { deliverable: 'answer', subject: 'the form' };
    const body = normalizeContract(declared, { sanitizer: new DefaultSanitizer(), command });
    if (!body.isOk) throw new Error(`fixture rejected: ${body.error.cause}`);
    await contract.declare(body.value, '2026-10-16T12:00:00.000Z');
    const actionLedger = newLedger();
    for (const set of sets) recordSet(actionLedger, set);
    const services = buildServices({
      runDir,
      contract,
      publish: createBriefPublisher(runDir),
      actionLedger,
    });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute(
      { brief: { title: 'Form', overview: 'The form was filled.' } },
      undefined,
    );
    expect(result.status).toBe('ok');
    return {
      brief: Brief.parse(JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'))),
      markdown: await readFile(join(runDir, 'brief.md'), 'utf8'),
      html: await readFile(join(runDir, 'brief.html'), 'utf8'),
    };
  }

  it('writes schema-valid artifacts and links them in brief.md and brief.html', async () => {
    const { brief, markdown, html } = await publish('do', [captureSet(1, 1)]);
    const path = `screenshots/capture-1-${SHA.slice(0, 12)}.png`;

    expect(brief.artifacts).toEqual([
      expect.objectContaining({ kind: 'screenshot', path, part: 1, parts: 1, complete: true }),
    ]);
    expect(markdown).toContain(`- [viewport screenshot](${path}), 1280x720`);
    expect(html).toContain(`<a href="${path}">viewport screenshot</a>`);
  });

  it('adds the overflow notice to a Brief with more than 12 files', async () => {
    const { brief } = await publish('do', [captureSet(1, 6), captureSet(2, 6), captureSet(3, 2)]);

    expect(brief.artifacts).toHaveLength(12);
    expect(brief.notices).toContainEqual({
      kind: 'other',
      source: 'captures',
      reason: "2 further capture files are in the run's screenshots folder.",
    });
  });

  it('writes no artifacts key when nothing was captured', async () => {
    const { brief } = await publish('do', []);

    expect('artifacts' in brief).toBe(false);
  });

  it('composes no artifacts key for research', async () => {
    const { brief } = await publish('research', [captureSet(1, 1)]);

    expect('artifacts' in brief).toBe(false);
  });
});
