/**
 * @no-llm core interaction message-catalog contract.
 *
 * Persisted text is always read with an explicit fatal UTF-8 decoder. Manual
 * Windows inspection must likewise use `Get-Content -Encoding utf8` or
 * `[System.IO.File]::ReadAllText`, never PowerShell 5.1's ANSI default.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as core from '../../src/index.js';
import {
  DanglingInteractionMessageError,
  INTERACTION_MESSAGES,
  fillFailure,
  renderInteractionMessage,
  type AttemptRecord,
} from '../../src/index.js';
import { readUtf8 } from '../support/gauntlet.js';

const FROZEN_STABLE_CODES = [
  'ELEMENT_DISABLED',
  'ELEMENT_HIDDEN',
  // Added by FEAT-033 — the one code this snapshot was explicitly reserved for.
  'ELEMENT_OBSTRUCTED',
  'FILL_VALUE_INVALID',
  'OPTION_NOT_FOUND',
  'STALE_ELEMENT_REF',
  'WIDGET_AMBIGUOUS_CHOICE',
  'WIDGET_DID_NOT_OPEN',
  'WIDGET_DISMISS_FAILED',
  'WIDGET_ELEMENT_REPLACED',
  'WIDGET_MAPPING_UNSAFE',
  'WIDGET_NOT_COMMITTED',
  'WIDGET_RANGE_INCOMPLETE',
  'WIDGET_TARGET_UNREACHABLE',
] as const;

describe('@no-llm core interaction message catalog', () => {
  it('has unique total keys and globally distinct rendered messages', () => {
    const keys = INTERACTION_MESSAGES.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);

    const rendered = INTERACTION_MESSAGES.map((template) =>
      template.message(detailsFor(template.requiredDetails)),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('renders every template from its declared details and fails on a dangling key', () => {
    for (const template of INTERACTION_MESSAGES) {
      const details = detailsFor(template.requiredDetails);
      expect(() =>
        renderInteractionMessage(template.surface, template.code, template.cause, details),
      ).not.toThrow();
      if (template.requiredDetails.length > 0) {
        expect(() =>
          renderInteractionMessage(template.surface, template.code, template.cause, {}),
        ).toThrow();
      }
    }
    expect(() => renderInteractionMessage('actionability', 'MISSING', 'missing', {})).toThrow(
      DanglingInteractionMessageError,
    );
  });

  it('resolves every engine capability to a public function', () => {
    for (const template of INTERACTION_MESSAGES) {
      if (template.capabilityKind !== 'engine' || template.capability === null) continue;
      expect(typeof core[template.capability as keyof typeof core]).toBe('function');
    }
  });

  it('never makes optional vision a required recovery step', () => {
    for (const template of INTERACTION_MESSAGES) {
      const details = detailsFor(template.requiredDetails);
      expect(`${template.message(details)} ${template.hint(details)}`).not.toContain(
        'browser_screenshot',
      );
    }
  });

  it('keeps the stable error-code set frozen', () => {
    const codes = [
      ...new Set(
        INTERACTION_MESSAGES.filter((entry) => entry.surface !== 'success-note').map(
          (entry) => entry.code,
        ),
      ),
    ].sort();
    expect(codes).toEqual(FROZEN_STABLE_CODES);
  });

  it('never serializes the internal failure cause', () => {
    const failure = fillFailure(
      'WIDGET_NOT_COMMITTED',
      'control-refused-value',
      'The control refused the value.',
      { observed: 'other' },
    );
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('control-refused-value');
  });

  it('round-trips every rendered message through UTF-8 unchanged', () => {
    for (const template of INTERACTION_MESSAGES) {
      const rendered = template.message(detailsFor(template.requiredDetails));
      expect(
        new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(rendered)),
      ).toBe(rendered);
    }
  });

  it('makes readUtf8 fail loudly on a CP-1252 byte sequence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'yantra-utf8-'));
    const path = join(directory, 'cp1252.txt');
    try {
      writeFileSync(path, Uint8Array.of(0x93, 0x78, 0x94));
      expect(() => readUtf8(path)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('@no-llm legacy ledger characterization for FEAT-034', () => {
  it('characterizes a successful rung with errorCode null inside an overall failure', () => {
    // FEAT-032 intentionally records today's nullable ledger. FEAT-034 replaces
    // this with discriminated rung verdicts and flips this characterization
    // into a prohibition; this test is green until that successor lands.
    const successfulRung: AttemptRecord = {
      attempt: 2,
      strategy: 'clear-then-type',
      axis: 'how',
      errorCode: null,
      elapsedMs: 4,
    };
    const overallFailure = {
      ok: false as const,
      errorCode: 'WIDGET_NOT_COMMITTED',
      details: { attempted: [successfulRung] },
    };

    expect(overallFailure.details.attempted[0]?.errorCode).toBeNull();
  });
});

function keyOf(template: {
  readonly surface: string;
  readonly code: string;
  readonly cause: string;
}): string {
  return `${template.surface}\u0000${template.code}\u0000${template.cause}`;
}

function detailsFor(keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(keys.map((key) => [key, representativeDetail(key)]));
}

/** A payload shaped the way the production caller actually supplies it. */
function representativeDetail(key: string): unknown {
  switch (key) {
    case 'offered':
    case 'attempted':
      return ['alpha', 'beta'];
    case 'offeredCount':
      return 2;
    case 'obstruction':
      return { role: 'dialog', name: 'Cookie choices' };
    case 'clearance_attempted':
      return false;
    case 'candidates':
      return [
        { ref: 'e41', role: 'button', name: 'Close', protected: false, auto_clearable: true },
      ];
    case 'kind':
      return 'modal-dialog';
    default:
      return `${key}-value`;
  }
}
