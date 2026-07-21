import { Writable } from 'node:stream';

import { validateBrief } from '@yantra/protocol';
import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { CLIConnectorIO } from '../../src/connector-io.js';
import { openerFor } from '../../src/open-artifact.js';
import { JSONRenderer } from '../../src/render/json.js';
import { TerminalRenderer } from '../../src/render/terminal.js';
import type { BriefArtifactPaths, ConnectorRenderOpts } from '../../src/render/types.js';

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, value: () => data };
}

function makeOpts(overrides: Partial<ConnectorRenderOpts>): ConnectorRenderOpts {
  const sink = captureStream();
  return {
    json: false,
    debug: false,
    noColor: true,
    stream: sink.stream,
    errStream: sink.stream,
    ...overrides,
  };
}

describe('@no-llm brief dispatch', () => {
  it('routes the brief connector result to renderBrief (terminal)', () => {
    const out = captureStream();
    const io = new CLIConnectorIO(new TerminalRenderer());

    io.renderResult(
      { kind: 'brief', brief: canonicalBrief, artifacts: null },
      makeOpts({ stream: out.stream }),
    );

    expect(out.value()).toContain('Cheapest Sony WH-1000XM5 today');
    expect(out.value()).toContain('Sources');
  });

  it('emits a byte-stable JSON envelope with the Brief verbatim', () => {
    const first = captureStream();
    const second = captureStream();
    const renderer = new JSONRenderer();

    renderer.renderBrief(canonicalBrief, null, makeOpts({ stream: first.stream, json: true }));
    renderer.renderBrief(canonicalBrief, null, makeOpts({ stream: second.stream, json: true }));

    expect(first.value()).toBe(second.value());
    const parsed = JSON.parse(first.value()) as { kind: string; brief: unknown };
    expect(parsed.kind).toBe('brief');
    expect(validateBrief(parsed.brief).isOk).toBe(true);
    expect((parsed.brief as { brief_id: string }).brief_id).toBe(canonicalBrief.brief_id);
  });

  it('the JSON envelope contains no ANSI escape bytes', () => {
    const out = captureStream();
    new JSONRenderer().renderBrief(
      canonicalBrief,
      null,
      makeOpts({ stream: out.stream, json: true }),
    );
    expect(out.value().includes(String.fromCharCode(0x1b))).toBe(false);
  });

  it('streams Markdown for --format md and HTML for --format html', () => {
    const md = captureStream();
    new TerminalRenderer().renderBrief(
      canonicalBrief,
      null,
      makeOpts({ stream: md.stream, briefFormat: 'md' }),
    );
    expect(md.value()).toContain('# Cheapest Sony WH-1000XM5 today');
    expect(md.value()).toContain('## Sources');

    const html = captureStream();
    new TerminalRenderer().renderBrief(
      canonicalBrief,
      null,
      makeOpts({ stream: html.stream, briefFormat: 'html' }),
    );
    expect(html.value().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.value()).toContain('<table class="comparison">');
  });

  it('appends an artifacts footer in terminal format when artifacts are present', () => {
    const out = captureStream();
    const artifacts: BriefArtifactPaths = {
      jsonPath: '/runs/x/brief.json',
      mdPath: '/runs/x/brief.md',
      htmlPath: '/runs/x/brief.html',
    };

    new TerminalRenderer().renderBrief(
      canonicalBrief,
      artifacts,
      makeOpts({ stream: out.stream, briefFormat: 'terminal' }),
    );

    expect(out.value()).toContain('Saved: /runs/x/brief.md · /runs/x/brief.html');
  });

  it('honors the terminal detail level through dispatch', () => {
    const overview = captureStream();
    new TerminalRenderer().renderBrief(
      canonicalBrief,
      null,
      makeOpts({ stream: overview.stream, briefDetail: 'overview' }),
    );
    expect(overview.value()).not.toContain('Key Findings');

    const standard = captureStream();
    new TerminalRenderer().renderBrief(
      canonicalBrief,
      null,
      makeOpts({ stream: standard.stream, briefDetail: 'standard' }),
    );
    expect(standard.value()).toContain('Key Findings');
  });

  it('selects the platform-appropriate opener command', () => {
    expect(openerFor('win32', '/x/brief.html')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', '/x/brief.html'],
    });
    expect(openerFor('darwin', '/x/brief.html')).toEqual({
      command: 'open',
      args: ['/x/brief.html'],
    });
    expect(openerFor('linux', '/x/brief.html')).toEqual({
      command: 'xdg-open',
      args: ['/x/brief.html'],
    });
  });
});
