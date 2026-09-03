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
      if (descriptor.file === 'shared-calendar-range.html') {
        expect(run.testPort.clickLog.filter((entry) => entry.name === 'Check-in')).toHaveLength(1);
        const attempts = run.outcome.ok ? (run.outcome.attempted ?? []) : [];
        expect(attempts.map((record) => record.strategy)).toEqual([
          'open-probe',
          'driver:calendar-grid',
        ]);
      }
    },
    35_000,
  );

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
    // deliberate edit. With the agent tier's four, this is the 17-fixture gate.
    expect(files).toHaveLength(13);
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
