// @no-llm
/**
 * The public run-artifact allowlist (FEAT-066 TASK-001): run ids, path
 * normalization, first-match-wins classification and default deny.
 */

import { describe, expect, it } from 'vitest';

import {
  DENIED_RUN_ARTIFACT,
  RUN_ARTIFACT_MEDIA_TYPES,
  RUN_ARTIFACT_REGISTRY,
  RunArtifactRegistry,
  RunArtifactRegistryEntry,
  RunId,
  classifyRunArtifact,
  isRunId,
  matchRunArtifactPattern,
  normalizeRunArtifactPath,
} from '../src/index.js';

describe('RunId', () => {
  it.each([
    '20260511T091234Z-bank-statement-a7b3',
    '20261022T011858Z-research-371284a7',
    '20260101T000000Z-a',
  ])('accepts %s', (id) => {
    expect(RunId.safeParse(id).success).toBe(true);
    expect(isRunId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['no timestamp', 'bank-statement-a7b3'],
    ['traversal', '20260511T091234Z-../x'],
    ['dot-dot only', '..'],
    ['slash', '20260511T091234Z-a/b'],
    ['backslash', '20260511T091234Z-a\\b'],
    ['drive letter', 'C:'],
    ['underscore', '20260511T091234Z-a_b'],
    ['agent smoke (not formatRunId)', 'agent-smoke-2026-11-12T00-00-00-000Z'],
    ['too long', `20260511T091234Z-${'a'.repeat(80)}`],
  ])('rejects %s', (_label, id) => {
    expect(RunId.safeParse(id).success).toBe(false);
    expect(isRunId(id)).toBe(false);
  });

  it('accepts exactly 96 characters and rejects 97', () => {
    const at96 = `20260511T091234Z-${'a'.repeat(96 - 17)}`;
    expect(at96).toHaveLength(96);
    expect(isRunId(at96)).toBe(true);
    expect(isRunId(`${at96}a`)).toBe(false);
  });
});

describe('normalizeRunArtifactPath', () => {
  it.each([
    ['brief.json', 'brief.json'],
    ['agent/session.jsonl', 'agent/session.jsonl'],
  ])('keeps %s', (input, expected) => {
    expect(normalizeRunArtifactPath(input)).toBe(expected);
  });

  it.each([
    '',
    '/etc/passwd',
    'C:/x',
    'c:x',
    'a\\b',
    '..',
    '../manifest.json',
    'a/../b',
    './brief.json',
    'a//b',
    'a/',
    'nul\0byte',
    '%2e%2e/x',
    'a%2Fb',
    'x'.repeat(513),
  ])('refuses %j', (input) => {
    expect(normalizeRunArtifactPath(input)).toBeNull();
  });
});

describe('matchRunArtifactPattern', () => {
  it.each([
    ['brief.json', 'brief.json', true],
    ['agent/*.jsonl', 'agent/s.jsonl', true],
    ['agent/*.jsonl', 'agent/sub/s.jsonl', false],
    ['*.tmp', 'brief.json.tmp', true],
    ['*.tmp', 'a/brief.json.tmp', false],
    ['**/*.tmp', 'a/b/brief.json.tmp', true],
    ['**/*.tmp', 'brief.json.tmp', true],
    ['decisions/**', 'decisions/x.json', true],
    ['decisions/**', 'decisions', true],
    ['**/chrome-profile/**', 'x/chrome-profile/Default/Cookies', true],
    ['brief.json', 'brief-json', false],
    ['captures/cap-*.txt', 'captures/cap-01ABC.txt', true],
    ['captures/cap-*.txt', 'captures/other.txt', false],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(matchRunArtifactPattern(pattern, path)).toBe(expected);
  });
});

describe('classifyRunArtifact', () => {
  it.each([
    ['brief.json', 'brief.json', 'typed', 'brief'],
    ['brief.md', 'brief.md', 'view', 'markdown'],
    ['brief.html', 'brief.html', 'download', 'none'],
    ['document.json', 'document.json', 'typed', 'document'],
    ['document.md', 'document.md', 'view', 'markdown'],
    ['document.html', 'document.html', 'download', 'none'],
    ['report.md', 'report.md', 'view', 'markdown'],
    ['outputs.json', 'outputs.json', 'view', 'json'],
    ['manifest.json', 'manifest.json', 'view', 'json'],
    ['usage.json', 'usage.json', 'view', 'json'],
    ['run-health.json', 'run-health.json', 'view', 'json'],
    ['contract.json', 'contract.json', 'view', 'json'],
    ['trace.json', 'trace.json', 'view', 'json'],
    ['schedule.json', 'schedule.json', 'view', 'json'],
    ['execution-receipt.json', 'execution-receipt.json', 'view', 'json'],
    ['events.jsonl', 'events.jsonl', 'view', 'jsonl'],
    ['run-events.jsonl', 'run-events.jsonl', 'view', 'jsonl'],
    ['runtime.jsonl', 'runtime.jsonl', 'view', 'jsonl'],
    ['tool-calls.jsonl', 'tool-calls.jsonl', 'view', 'jsonl'],
    ['confirmations.jsonl', 'confirmations.jsonl', 'view', 'jsonl'],
    ['secrets.jsonl', 'secrets.jsonl', 'view', 'jsonl'],
    ['interventions.jsonl', 'interventions.jsonl', 'view', 'jsonl'],
    ['agent.jsonl', 'agent.jsonl', 'view', 'jsonl'],
    ['agent/x.jsonl', 'agent-session', 'view', 'jsonl'],
    ['screenshots/1-abcdef123456.png', 'screenshots', 'view', 'image'],
    ['screenshots/capture-2-abcdef123456-p1.png', 'screenshots', 'view', 'image'],
    ['captures/cap-01J.txt', 'capture-text', 'view', 'text'],
    ['captures/shot.png', 'capture-images', 'view', 'image'],
  ])('%s → %s (%s, %s)', (path, id, exposure, viewer) => {
    const entry = classifyRunArtifact(path);
    expect(entry.id).toBe(id);
    expect(entry.exposure).toBe(exposure);
    expect(entry.viewer).toBe(viewer);
  });

  it.each([
    'lease.json',
    'reconcile.lock',
    '.lock',
    'decisions/x.json',
    'decisions/nested/y.json',
    'brief.json.tmp',
    'agent/x.jsonl.tmp',
    'run.sock',
    'agent/chrome-profile/Default/Cookies',
    'chrome-profile/Default/Cookies',
    'x/user-data-dir/Local State',
    'screenshots/evil.png',
    'screenshots/1-ABCDEF123456.png',
    'screenshots/sub/1-abcdef123456.png',
    'captures/cap-1.json',
    'captures/sub/x.png',
    'plan.json',
    'research-state.json',
    'owned-browsers.jsonl',
    'unknown.bin',
    '../manifest.json',
    'a\\b',
    'C:/x',
    '%2e%2e/x',
    '/brief.json',
  ])('denies %s', (path) => {
    const entry = classifyRunArtifact(path);
    expect(entry.exposure).toBe('denied');
  });

  it('returns the default-deny entry for anything unmatched', () => {
    expect(classifyRunArtifact('not/listed.txt')).toBe(DENIED_RUN_ARTIFACT);
  });

  it('lets an explicit denial beat a later allow (a .tmp under agent/)', () => {
    // agent/*.jsonl would never match a .tmp name, so prove ordering with a lock
    // that sits where an allowed glob would otherwise reach.
    const denialIndex = RUN_ARTIFACT_REGISTRY.findIndex((entry) => entry.pattern === '**/*.tmp');
    const allowIndex = RUN_ARTIFACT_REGISTRY.findIndex((entry) => entry.id === 'agent-session');
    expect(denialIndex).toBeGreaterThanOrEqual(0);
    expect(denialIndex).toBeLessThan(allowIndex);
    expect(classifyRunArtifact('agent/x.tmp').exposure).toBe('denied');
  });

  it('puts every denial before every allowed entry', () => {
    const lastDenial = RUN_ARTIFACT_REGISTRY.map((entry) => entry.exposure).lastIndexOf('denied');
    const firstAllow = RUN_ARTIFACT_REGISTRY.findIndex((entry) => entry.exposure !== 'denied');
    expect(lastDenial).toBeLessThan(firstAllow);
  });
});

describe('RUN_ARTIFACT_REGISTRY', () => {
  it('parses as the published schema', () => {
    expect(RunArtifactRegistry.safeParse(RUN_ARTIFACT_REGISTRY).success).toBe(true);
    for (const entry of RUN_ARTIFACT_REGISTRY) {
      expect(RunArtifactRegistryEntry.parse(entry)).toEqual(entry);
    }
  });

  it('has unique ids', () => {
    const ids = RUN_ARTIFACT_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry a description and an allowlisted media type', () => {
    for (const entry of RUN_ARTIFACT_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(RUN_ARTIFACT_MEDIA_TYPES).toContain(entry.media_type);
    }
  });

  it('serves HTML only as a download', () => {
    const html = RUN_ARTIFACT_REGISTRY.filter((entry) => entry.media_type.startsWith('text/html'));
    expect(html.map((entry) => entry.id).sort()).toEqual(['brief.html', 'document.html']);
    for (const entry of html) expect(entry.exposure).toBe('download');
  });

  it('caps every whole-file viewer and leaves JSONL windowed', () => {
    for (const entry of RUN_ARTIFACT_REGISTRY) {
      if (entry.exposure === 'denied' || entry.exposure === 'download') continue;
      if (entry.viewer === 'jsonl') expect(entry.inline_cap_bytes).toBeNull();
      else expect(entry.inline_cap_bytes).toBeGreaterThan(0);
    }
  });

  it.each([
    ['brief.json', 512 * 1024],
    ['brief.md', 2 * 1024 * 1024],
    ['document.json', 512 * 1024],
    ['report.md', 512 * 1024],
    ['outputs.json', 2 * 1024 * 1024],
    ['screenshots', 20 * 1024 * 1024],
    ['capture-text', 2 * 1024 * 1024],
    ['capture-images', 20 * 1024 * 1024],
  ])('caps %s at %d bytes', (id, cap) => {
    expect(RUN_ARTIFACT_REGISTRY.find((entry) => entry.id === id)?.inline_cap_bytes).toBe(cap);
  });
});
