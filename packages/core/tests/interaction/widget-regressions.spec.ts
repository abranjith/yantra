/**
 * @no-llm protocol-tier widget gauntlet.
 *
 * Every case names a generic structural pattern and reports its own semantic
 * outcome plus exact mutation/read counts. Fixture text is decoded explicitly
 * as UTF-8; on Windows, inspect the same files with `Get-Content -Encoding
 * utf8` (or `[System.IO.File]::ReadAllText`), never a default ANSI decoder.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { INTERACTION_MESSAGES, receiverFor } from '../../src/index.js';
import {
  PROTOCOL_GAUNTLET,
  countingPort,
  protocolFixtureDirectory,
  protocolFixtureFiles,
  readUtf8,
  runFixture,
  type GauntletFixture,
} from '../support/gauntlet.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

describe('@no-llm authoritative widget-port accounting', () => {
  it('counts type and press as mutations, reads separately, and now as neutral', async () => {
    const base = new WidgetTestPort('<input id="q" aria-label="Query">');
    const counted = countingPort(base);
    const ref = base.refFor('#q');

    await counted.port.type(ref, 'x');
    await counted.port.press('Enter');
    expect(counted.counts).toMatchObject({ mutations: 2, reads: 0 });

    await counted.port.observe();
    await counted.port.evaluateOn(ref, (element) => element.getAttribute('aria-label'));
    counted.port.now();

    expect(counted.counts.mutations).toBe(2);
    expect(counted.counts.reads).toBe(2);
    expect(counted.counts.byAction).toMatchObject({
      type: 1,
      press: 1,
      observe: 1,
      evaluateOn: 1,
      now: 1,
    });
  });
});

describe('@no-llm protocol widget gauntlet', () => {
  it.each(PROTOCOL_GAUNTLET)(
    '$pattern',
    async (descriptor) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const pending = runFixture(descriptor);
      await vi.runAllTimersAsync();
      const run = await pending;

      expect(run.result.outcome).toBe(descriptor.expected.kind);
      expect(run.result.mutations).toBe(descriptor.expectedMutations);
      expect(run.result.reads).toBe(descriptor.expectedReads);

      if (descriptor.expected.kind === 'commit') {
        expect(run.outcome).toMatchObject({
          ok: true,
          committed: descriptor.expected.committed,
          ...(descriptor.expected.resolution ? { resolution: descriptor.expected.resolution } : {}),
          ...(descriptor.expected.driver ? { driver: descriptor.expected.driver } : {}),
          ...(descriptor.expected.editee ? { editee: descriptor.expected.editee } : {}),
        });
        if (descriptor.expected.noteContains) {
          expect(run.outcome.ok && run.outcome.note).toContain(descriptor.expected.noteContains);
        }
        for (const forbidden of descriptor.expected.forbiddenOffered ?? []) {
          expect(JSON.stringify(run.outcome)).not.toContain(forbidden);
        }
      } else {
        expect(run.outcome).toMatchObject({
          ok: false,
          errorCode: descriptor.expected.errorCode,
        });
        if (!run.outcome.ok) {
          for (const key of descriptor.expected.detailKeys) {
            expect(run.outcome.details).toHaveProperty(key);
          }
        }
        expect(run.followUp).toMatchObject({
          ok: true,
          committed: descriptor.expected.followUp.committed,
        });
        if (descriptor.file === 'split-date-fields.html') {
          expect(run.inputValuesAfterFirst).toEqual(['', '']);
        }
      }

      expect(run.testPort.document.querySelector(descriptor.field.selector)).not.toBeNull();
      for (const offered of offeredArrays([run.outcome, run.followUp])) {
        expect(new Set(offered.map(normalizedChoice)).size).toBe(offered.length);
      }
      for (const outcome of [run.outcome, run.followUp]) {
        if (outcome?.ok !== true || outcome.substitution === undefined) continue;
        expect(outcome.note).toBeTruthy();
        expect(outcome.substitution.tieBreak).toContain('document-order');
      }
      if (descriptor.file === 'shared-calendar-range.html') {
        expect(run.testPort.clickLog.filter((entry) => entry.name === 'Check-in')).toHaveLength(1);
        // Completion order, which is the runner's only ordering authority: the
        // nested drive finishes before the probe rung that started it, so its
        // verdict precedes the probe's. The merge that used to insert a
        // driver-local ledger *after* its owning rung is gone.
        const attempts = (run.outcome.ok ? (run.outcome.attempted ?? []) : []).filter(
          (record) => record.verdict !== 'skipped',
        );
        expect(attempts.map((record) => record.strategy)).toEqual([
          'driver:calendar-grid',
          'open-probe',
        ]);
      }
      if (descriptor.file === 'indistinguishable-choices.html') {
        expect(run.outcome.ok && run.outcome.substitution).toMatchObject({
          indistinguishable: 2,
          position: 1,
        });
        expect(run.outcome.ok && run.outcome.note).toContain('Sunday, September 6, 2026');
        // The ledger carries the count, the position and the rungs that
        // narrowed the pool — never the shared label, which is page text and
        // could not have distinguished them anyway.
        const ledger = run.outcome.ok ? (run.outcome.attempted ?? []) : [];
        expect(JSON.stringify(ledger)).not.toContain('Sunday, September 6, 2026');
      }
      if (descriptor.file === 'offered-label-roundtrip-date.html') {
        expect(run.outcome.ok ? [] : run.outcome.details.offered).toEqual([
          '2026-09: Morning departure',
          '2026-09: Evening departure',
        ]);
        expect(run.result.byAction.type ?? 0).toBe(0);
        expect(run.result.byAction.press ?? 0).toBe(0);
      }
    },
    35_000,
  );

  it('answers every engineered refusal within four seconds of the injected clock', async () => {
    // FEAT-034 TASK-012 (c), end to end. Measured on the mocked system clock —
    // the sum of the waits the engine actually chose to take — never on wall
    // time, so it is deterministic on the macOS, Windows and Ubuntu matrix.
    const refusals = PROTOCOL_GAUNTLET.filter(
      (entry) => entry.expected.kind === 'engineered-refusal',
    );
    expect(refusals.length).toBeGreaterThan(0);

    const elapsed: Record<string, number> = {};
    for (const descriptor of refusals) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const startedAt = Date.now();
      const pending = runFixture(descriptor);
      await vi.runAllTimersAsync();
      await pending;
      elapsed[descriptor.file] = Date.now() - startedAt;
      vi.useRealTimers();
    }

    expect(
      Object.fromEntries(Object.entries(elapsed).map(([file, ms]) => [file, ms <= 4_000])),
    ).toEqual(Object.fromEntries(Object.keys(elapsed).map((file) => [file, true])));
  }, 60_000);

  it('reports a second mask-equivalent spelling as reformatted', async () => {
    const masked = PROTOCOL_GAUNTLET.find((entry) => entry.file === 'masked-input.html')!;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const pending = runFixture({
      ...masked,
      intent: { kind: 'text', text: '555 123 4567' },
      expected: {
        kind: 'commit',
        committed: '(555) 123-4567',
        resolution: 'reformatted',
      },
    });
    await vi.runAllTimersAsync();
    const run = await pending;
    expect(run.outcome).toMatchObject({
      ok: true,
      committed: '(555) 123-4567',
      resolution: 'reformatted',
    });
  });

  it('has one registry entry per fixture file in both directions', () => {
    const files = protocolFixtureFiles();
    const registered = PROTOCOL_GAUNTLET.map((entry) => entry.file).sort();
    expect(census(files, registered)).toEqual({ unregistered: [], missing: [] });
    // The protocol half of the gallery, stated as a number so growing it is a
    // deliberate edit. With the agent tier's four, this is the 20-fixture gate.
    expect(files).toHaveLength(16);
  });

  it('rejects orphan files and entries independently', () => {
    expect(census(['one.html', 'orphan.html'], ['one.html'])).toEqual({
      unregistered: ['orphan.html'],
      missing: [],
    });
    expect(census(['one.html'], ['one.html', 'missing.html'])).toEqual({
      unregistered: [],
      missing: ['missing.html'],
    });
  });

  it('uses unique generic pattern names', () => {
    const patterns = PROTOCOL_GAUNTLET.map((entry) => entry.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('resolves a receiver for every capability-bearing template emitter', () => {
    for (const template of INTERACTION_MESSAGES) {
      if (template.capabilityKind !== 'engine' || template.capability === null) continue;
      for (const family of template.emittedBy ?? []) {
        expect(receiverFor(template.surface, family, template.capability)).not.toBeNull();
      }
    }
  });

  it('contains provenance site tokens only in leading fixture comments and never production source', () => {
    for (const descriptor of PROTOCOL_GAUNTLET) assertProvenanceContainment(descriptor);
  });

  it('strictly decodes fixture punctuation as UTF-8', () => {
    const text = readUtf8(join(protocolFixtureDirectory(), 'click-to-reveal-calendar.html'));
    expect(text).toContain('—');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(text))).toBe(
      text,
    );
  });

  it('throws instead of replacing an invalid Latin-1 byte', () => {
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0x96))).toThrow();
  });
});

afterEach(() => vi.useRealTimers());

function census(
  files: readonly string[],
  registered: readonly string[],
): { readonly unregistered: readonly string[]; readonly missing: readonly string[] } {
  const fileSet = new Set(files);
  const registeredSet = new Set(registered);
  return {
    unregistered: files.filter((file) => !registeredSet.has(file)).sort(),
    missing: registered.filter((file) => !fileSet.has(file)).sort(),
  };
}

function offeredArrays(value: unknown): readonly (readonly string[])[] {
  if (Array.isArray(value)) {
    const nested = value.flatMap(offeredArrays);
    return value.every((entry) => typeof entry === 'string')
      ? [value as string[], ...nested]
      : nested;
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === 'offered' && Array.isArray(entry) && entry.every((member) => typeof member === 'string')
      ? [entry as string[]]
      : offeredArrays(entry),
  );
}

function normalizedChoice(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertProvenanceContainment(descriptor: GauntletFixture): void {
  const site = descriptor.provenance.site;
  if (!site) return;
  const fixture = readUtf8(join(protocolFixtureDirectory(), descriptor.file));
  const leadingComment = /^\s*<!--([\s\S]*?)-->/.exec(fixture)?.[1] ?? '';
  expect(leadingComment).toContain(site);
  expect(fixture.slice(fixture.indexOf('-->') + 3)).not.toContain(site);

  const sourceRoots = ['packages/core/src', 'packages/agent/src'];
  for (const root of sourceRoots) {
    for (const path of sourceFiles(root)) expect(readUtf8(path)).not.toContain(site);
  }
}

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}
