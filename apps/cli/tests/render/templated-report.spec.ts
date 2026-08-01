import { Writable } from 'node:stream';

import type { TemplatedReport } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { CLIConnectorIO } from '../../src/connector-io.js';
import { CLI_JSON_SCHEMA_VERSION, JSONRenderer } from '../../src/render/json.js';
import { TerminalRenderer } from '../../src/render/terminal.js';
import type { BriefOutputFormat, ConnectorRenderOpts } from '../../src/render/types.js';

function capture() {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    value: () => value,
  };
}

const report = {
  report_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  schema_version: '0.2',
  template: { name: 'weekly', source: 'saved', path: null, hash: 'a'.repeat(64) },
  title: 'Weekly update',
  slots: { title: 'Weekly update', summary: 'All systems are healthy.' },
  rendered_md: '# Weekly update\n\n<script>alert(1)</script>\n',
  sources: [],
  metadata: {
    search_provider: null,
    synthesis: 'llm',
    deterministic_fallback_used: false,
    coverage: null,
    freshness: null,
    citation_verdict: null,
    usage: null,
    evidence: null,
    run_id: 'run-1',
  },
  notices: [],
} as TemplatedReport;

function opts(format: BriefOutputFormat, stream: NodeJS.WritableStream): ConnectorRenderOpts {
  return {
    json: format === 'json',
    debug: false,
    noColor: true,
    stream,
    errStream: stream,
    briefFormat: format,
  };
}

describe('@no-llm templated report rendering', () => {
  it.each(['terminal', 'md'] as const)('writes canonical Markdown for %s', (format) => {
    const output = capture();
    new CLIConnectorIO(new TerminalRenderer()).renderResult(
      { kind: 'templated_report', report, artifacts: null },
      opts(format, output.stream),
    );
    expect(output.value()).toBe(report.rendered_md);
    expect(output.value()).not.toContain('\u001b');
  });

  it('writes inert self-contained HTML', () => {
    const output = capture();
    new CLIConnectorIO(new TerminalRenderer()).renderResult(
      { kind: 'templated_report', report, artifacts: null },
      opts('html', output.stream),
    );
    expect(output.value()).toContain('<!DOCTYPE html>');
    expect(output.value()).not.toContain('<script>');
    expect(output.value()).toContain('&lt;script&gt;');
  });

  it('writes a stable top-level JSON envelope whose title is directly queryable', () => {
    const one = capture();
    const two = capture();
    for (const output of [one, two]) {
      new CLIConnectorIO(new JSONRenderer()).renderResult(
        { kind: 'templated_report', report, artifacts: null },
        opts('json', output.stream),
      );
    }
    expect(one.value()).toBe(two.value());
    expect(JSON.parse(one.value())).toMatchObject({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: 'templated_report',
      title: 'Weekly update',
    });
  });
});
