import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Brief, BriefArtifact } from '@yantra/protocol';
import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { TerminalRenderer, briefCaptureLines } from '../../src/render/terminal.js';

const SHA = 'ef'.repeat(32);

function artifact(part: number, parts: number, extra: Partial<BriefArtifact> = {}): BriefArtifact {
  return {
    kind: 'screenshot',
    scope: parts > 1 ? 'full_page' : 'viewport',
    path: `screenshots/capture-1-${SHA.slice(0, 12)}${parts > 1 ? `-p${part}` : ''}.png`,
    sha256: SHA,
    bytes: 100,
    width: 1280,
    height: parts > 1 ? 4096 : 720,
    part,
    parts,
    complete: true,
    labels: [],
    ...extra,
  };
}

function withArtifacts(artifacts: readonly BriefArtifact[]): Brief {
  return { ...canonicalBrief, artifacts: [...artifacts] };
}

describe('@no-llm terminal Brief captures (FEAT-058)', () => {
  it('lists nothing for a Brief without captures', () => {
    expect(briefCaptureLines(canonicalBrief, '/runs/run-1')).toBe('');
    expect(briefCaptureLines(withArtifacts([]), '/runs/run-1')).toBe('');
  });

  it('lists each capture with its absolute path when the run directory is known', () => {
    const lines = briefCaptureLines(
      withArtifacts([
        artifact(1, 2, { complete: false, labels: ['truncated'] }),
        artifact(2, 2, { complete: false, labels: ['truncated'] }),
      ]),
      '/runs/run-1',
    );

    expect(lines).toBe(
      '\nCaptures:\n' +
        `  full-page screenshot, part 1 of 2: ${join('/runs/run-1', 'screenshots', `capture-1-${SHA.slice(0, 12)}-p1.png`)}, 1280x4096 (incomplete: truncated)\n` +
        `  full-page screenshot, part 2 of 2: ${join('/runs/run-1', 'screenshots', `capture-1-${SHA.slice(0, 12)}-p2.png`)}, 1280x4096 (incomplete: truncated)\n`,
    );
  });

  it('falls back to the relative path without a run directory, and never joins a bad path', () => {
    expect(briefCaptureLines(withArtifacts([artifact(1, 1)]), null)).toContain(
      `viewport screenshot: screenshots/capture-1-${SHA.slice(0, 12)}.png, 1280x720`,
    );
    expect(
      briefCaptureLines(withArtifacts([artifact(1, 1, { path: '../../etc/x.png' })]), '/runs/r'),
    ).toContain('viewport screenshot: ../../etc/x.png, 1280x720');
  });

  it('prints the list after the terminal Brief', () => {
    let text = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    });

    new TerminalRenderer().renderBrief(
      withArtifacts([artifact(1, 1)]),
      {
        mdPath: '/runs/run-1/brief.md',
        htmlPath: '/runs/run-1/brief.html',
        jsonPath: '/runs/run-1/brief.json',
      } as never,
      { json: false, debug: false, noColor: true, stream, errStream: stream },
    );

    expect(text).toContain('\nCaptures:\n  viewport screenshot: ');
    expect(text.indexOf('Captures:')).toBeLessThan(text.indexOf('Saved: '));
  });
});
