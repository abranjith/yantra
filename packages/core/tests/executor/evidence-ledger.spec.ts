// @no-llm
import { describe, expect, it } from 'vitest';

import {
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_TEXT_BYTES,
  ReplayEvidenceLedger,
  type ReplayEvidenceEntry,
} from '../../src/executor/evidence-ledger.js';

function makeEntry(overrides: Partial<ReplayEvidenceEntry> = {}): ReplayEvidenceEntry {
  return {
    url: 'https://example.com/a',
    finalUrl: null,
    host: 'example.com',
    title: 'Example',
    text: 'body text',
    fetchedAt: '2026-07-28T00:00:00.000Z',
    stepId: 's1',
    ...overrides,
  };
}

describe('@no-llm ReplayEvidenceLedger', () => {
  it('retains appended entries in append order', () => {
    const ledger = new ReplayEvidenceLedger();

    ledger.append(makeEntry({ url: 'https://a.test/1', stepId: 's1' }));
    ledger.append(makeEntry({ url: 'https://b.test/2', stepId: 's2' }));

    expect(ledger.entries().map((entry) => entry.url)).toEqual([
      'https://a.test/1',
      'https://b.test/2',
    ]);
    expect(ledger.overflowCount()).toBe(0);
  });

  it('preserves every recorded field verbatim', () => {
    const ledger = new ReplayEvidenceLedger();
    const entry = makeEntry({
      url: 'https://news.test/story',
      finalUrl: 'https://news.test/story/final',
      host: 'news.test',
      title: 'A story',
      text: 'the article body',
      fetchedAt: '2026-01-02T03:04:05.000Z',
      stepId: 's7',
    });

    ledger.append(entry);

    expect(ledger.entries()[0]).toEqual(entry);
  });

  it('drops the oldest entry and bumps overflow on the 33rd append', () => {
    const ledger = new ReplayEvidenceLedger();

    for (let index = 0; index < MAX_EVIDENCE_ENTRIES; index += 1) {
      ledger.append(makeEntry({ url: `https://example.com/${index}`, stepId: `s${index}` }));
    }
    expect(ledger.entries()).toHaveLength(MAX_EVIDENCE_ENTRIES);
    expect(ledger.overflowCount()).toBe(0);

    ledger.append(makeEntry({ url: 'https://example.com/overflow', stepId: 'sX' }));

    expect(ledger.entries()).toHaveLength(MAX_EVIDENCE_ENTRIES);
    expect(ledger.entries()[0]?.url).toBe('https://example.com/1');
    expect(ledger.entries().at(-1)?.url).toBe('https://example.com/overflow');
    expect(ledger.overflowCount()).toBe(1);
  });

  it('evicts oldest entries when the byte cap is exceeded', () => {
    const ledger = new ReplayEvidenceLedger();

    ledger.append(makeEntry({ url: 'https://small.test/', text: 'tiny' }));
    ledger.append(makeEntry({ url: 'https://big.test/', text: 'x'.repeat(300 * 1024) }));

    // The 300 KB body alone exceeds the 256 KB budget: the small entry is
    // evicted and the oversized body is truncated to the cap.
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]?.url).toBe('https://big.test/');
    expect(Buffer.byteLength(ledger.entries()[0]?.text ?? '', 'utf8')).toBe(
      MAX_EVIDENCE_TEXT_BYTES,
    );
    expect(ledger.overflowCount()).toBeGreaterThanOrEqual(1);
  });

  it('keeps total retained text within the byte cap across many appends', () => {
    const ledger = new ReplayEvidenceLedger();
    const chunk = 'y'.repeat(64 * 1024);

    for (let index = 0; index < 8; index += 1) {
      ledger.append(makeEntry({ url: `https://example.com/${index}`, text: chunk }));
    }

    const totalBytes = ledger
      .entries()
      .reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_BYTES);
    expect(ledger.overflowCount()).toBeGreaterThan(0);
    // Eviction is oldest-first: the newest read always survives.
    expect(ledger.entries().at(-1)?.url).toBe('https://example.com/7');
  });

  it('never splits a multi-byte character when truncating', () => {
    const ledger = new ReplayEvidenceLedger(4, 16);

    ledger.append(makeEntry({ text: '€'.repeat(20) }));

    const stored = ledger.entries()[0]?.text ?? '';
    expect(stored).not.toContain('�');
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(16);
  });

  it('honors constructor cap overrides', () => {
    const ledger = new ReplayEvidenceLedger(2, MAX_EVIDENCE_TEXT_BYTES);

    ledger.append(makeEntry({ url: 'https://example.com/1' }));
    ledger.append(makeEntry({ url: 'https://example.com/2' }));
    ledger.append(makeEntry({ url: 'https://example.com/3' }));

    expect(ledger.entries().map((entry) => entry.url)).toEqual([
      'https://example.com/2',
      'https://example.com/3',
    ]);
    expect(ledger.overflowCount()).toBe(1);
  });

  it('starts empty', () => {
    const ledger = new ReplayEvidenceLedger();

    expect(ledger.entries()).toEqual([]);
    expect(ledger.overflowCount()).toBe(0);
  });
});
