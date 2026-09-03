/**
 * @no-llm obstruction evidence at the agent seam.
 *
 * Persisted text is always read with an explicit fatal UTF-8 decoder. Manual
 * Windows inspection must likewise use `Get-Content -Encoding utf8` or
 * `[System.IO.File]::ReadAllText`, never PowerShell 5.1's ANSI default —
 * two separate investigations have raised false mojibake alarms from readers.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ElementObstructedError,
  PROTECTED_ACTION_RE as CORE_PROTECTED_ACTION_RE,
  type AgentBrowserController,
  type Obstruction,
  type UserInputVault,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { browserClickSpec } from '../../../../src/adapters/pi/tools/browser-click.js';
import { PROTECTED_ACTION_RE } from '../../../../src/adapters/pi/tools/browser-common.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { RunServices } from '../../../../src/runtime/run-services.js';
import { UrlProvenance } from '../../../../src/runtime/url-provenance.js';

import { buildServices } from './test-support.js';

const CREDENTIAL = 'sk-ABCDEF0123456789abcdef01';
const EMAIL = 'admin@example.com';

function obstruction(overrides: Partial<Obstruction> = {}): Obstruction {
  return {
    kind: 'modal-dialog',
    identity: { role: 'dialog', name: `Signed in as ${EMAIL} token ${CREDENTIAL}` },
    point: { x: 412, y: 268 },
    clearanceAttempted: false,
    clearanceSkipped: 'no-eligible-candidate',
    clearanceResult: null,
    candidates: [
      {
        ref: 'e41',
        role: 'button',
        name: `Close ${EMAIL}`,
        protectedAction: false,
        autoClearable: false,
      },
    ],
    candidatesTruncated: false,
    ...overrides,
  };
}

function fakeController(error: unknown) {
  return {
    navigate: vi.fn(),
    observe: vi.fn().mockResolvedValue({
      url: 'https://example.com/page',
      title: 'Page',
      digest: '',
      digestUnchanged: false,
      interactables: [],
    }),
    click: vi.fn().mockRejectedValue(error),
    fill: vi.fn(),
    extract: vi.fn(),
    adoptPopup: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue('https://example.com/page'),
    host: vi.fn().mockReturnValue('example.com'),
    describeRef: vi.fn().mockReturnValue({ ref: 'e1', role: 'button', name: 'Apply filters' }),
    locatorFor: vi.fn().mockResolvedValue([]),
    beginToolCall: vi.fn(),
  };
}

function servicesFor(
  controller: ReturnType<typeof fakeController>,
  userInput?: UserInputVault,
): RunServices {
  const provenance = new UrlProvenance();
  provenance.record('https://example.com/');
  return buildServices({
    urlProvenance: provenance,
    ...(userInput ? { userInput } : {}),
    domain: {
      browser: {
        controller: controller as unknown as AgentBrowserController,
        ethics: { check: () => Promise.resolve() },
        secretResolver: null,
        secretHosts: () => Promise.resolve([]),
        captureThresholdBytes: 1024,
      },
    },
  });
}

async function clickOnce(
  controller: ReturnType<typeof fakeController>,
  userInput?: UserInputVault,
) {
  const services = servicesFor(controller, userInput);
  return {
    services,
    result: await wrapTool(browserClickSpec(services), services).execute({ ref: 'e1' }, undefined),
  };
}

describe('@no-llm obstruction evidence at the agent seam', () => {
  it('sanitizes the overlay and candidate names in the message AND the details', async () => {
    const controller = fakeController(new ElementObstructedError(obstruction()));
    const { result } = await clickOnce(controller);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('ELEMENT_OBSTRUCTED');
    // The failure that fails if the message is rendered before sanitizing: the
    // model-visible sentence and the recorded details are built from the same
    // sanitized values, so they cannot disagree.
    expect(result.modelText).not.toContain(CREDENTIAL);
    expect(result.modelText).not.toContain(EMAIL);
    const details = result.details as {
      readonly obstruction: { readonly name: string };
      readonly candidates: readonly { readonly name: string }[];
    };
    expect(details.obstruction.name).not.toContain(CREDENTIAL);
    expect(details.obstruction.name).not.toContain(EMAIL);
    expect(details.candidates[0]!.name).not.toContain(EMAIL);
    expect(JSON.stringify(result.details)).not.toContain(CREDENTIAL);
  });

  it('returns a user-supplied value echoed into an overlay name as its placeholder', async () => {
    const vault: UserInputVault = {
      mask: (text: string) => text.replaceAll('Ada Lovelace', '{{user:name}}'),
      resolve: (text: string) => text,
      has: () => true,
    } as unknown as UserInputVault;
    const controller = fakeController(
      new ElementObstructedError(
        obstruction({ identity: { role: 'dialog', name: 'Welcome back, Ada Lovelace' } }),
      ),
    );
    const { result } = await clickOnce(controller, vault);
    const details = result.details as { readonly obstruction: { readonly name: string } };
    expect(details.obstruction.name).toContain('{{user:name}}');
    expect(details.obstruction.name).not.toContain('Ada Lovelace');
    expect(result.modelText).not.toContain('Ada Lovelace');
  });

  it('keeps the structural fields verbatim and names the offered refs to the model', async () => {
    const controller = fakeController(
      new ElementObstructedError(
        obstruction({
          identity: { role: 'dialog', name: 'Cookie choices' },
          clearanceAttempted: true,
          clearanceSkipped: null,
          clearanceResult: 'still-obstructed',
          candidates: [
            {
              ref: 'e41',
              role: 'button',
              name: 'Close',
              protectedAction: false,
              autoClearable: true,
            },
          ],
        }),
      ),
    );
    const { result } = await clickOnce(controller);
    // `kind`, `clearance_*` and `point` are fixed enums, booleans and numbers by
    // construction; they carry no page text and are logged verbatim.
    expect(result.details).toMatchObject({
      kind: 'modal-dialog',
      point: { x: 412, y: 268 },
      clearance_attempted: true,
      clearance_skipped: null,
      clearance_result: 'still-obstructed',
      candidates_truncated: false,
    });
    // Failure details are not model-visible, so the catalog message has to name
    // the refs in prose for the offer to reach the agent at all.
    expect(result.modelText).toContain('e41');
    expect(result.modelText).toContain('browser_click');
    expect(result.retryable).toBe(true);
  });

  it('reads differently for a modal and a pinned band covering the same control', async () => {
    const modal = await clickOnce(
      fakeController(
        new ElementObstructedError(
          obstruction({ identity: { role: 'dialog', name: 'Cookie choices' } }),
        ),
      ),
    );
    const band = await clickOnce(
      fakeController(
        new ElementObstructedError(
          obstruction({
            kind: 'fixed-overlay',
            identity: { role: 'div', name: 'Site navigation' },
            candidates: [],
          }),
        ),
      ),
    );
    expect(modal.result.modelText).not.toBe(band.result.modelText);
    expect(band.result.modelText).toContain('browser_observe');
  });

  it('opens exactly one clearance allowance per top-level tool call', async () => {
    // The bound is scoped to the call, not the action, and only the middleware
    // knows where a call starts.
    const controller = fakeController(new ElementObstructedError(obstruction()));
    await clickOnce(controller);
    expect(controller.beginToolCall).toHaveBeenCalledTimes(1);
  });

  it('re-exports the protected-action lexicon as the same object core owns', () => {
    // One source of truth: the agent's confirmation gateway and core's
    // auto-clearance veto must never drift into two regexes.
    expect(PROTECTED_ACTION_RE).toBe(CORE_PROTECTED_ACTION_RE);
  });
});

describe('@no-llm obstruction projection into a run artifact', () => {
  let runDir: string;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-obstruction-'));
  });

  afterAll(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  it('round-trips the recorded projection through an explicit UTF-8 decoder', async () => {
    const controller = fakeController(
      new ElementObstructedError(
        obstruction({
          identity: { role: 'dialog', name: 'Choix des cookies — préférences' },
          candidates: [
            {
              ref: 'e41',
              role: 'button',
              name: 'Non merci',
              protectedAction: false,
              autoClearable: false,
            },
          ],
        }),
      ),
    );
    const { result } = await clickOnce(controller);
    const path = join(runDir, 'tool-calls.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({
        tool: 'browser_click',
        phase: 'end',
        status: 'error',
        error_code: result.error_code,
        details: result.details,
      })}\n`,
      'utf8',
    );

    // Explicit fatal decoder: an encoding assertion that reads bytes through a
    // default decoder tests the reader, not the writer.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    const record = JSON.parse(text.trim()) as {
      readonly error_code: string;
      readonly details: {
        readonly kind: string;
        readonly clearance_attempted: boolean;
        readonly obstruction: { readonly name: string };
        readonly candidates: readonly { readonly ref: string }[];
      };
    };
    expect(record.error_code).toBe('ELEMENT_OBSTRUCTED');
    expect(record.details.kind).toBe('modal-dialog');
    expect(record.details.clearance_attempted).toBe(false);
    expect(record.details.candidates.map((entry) => entry.ref)).toEqual(['e41']);
    expect(record.details.obstruction.name).toContain('préférences');
  });
});
