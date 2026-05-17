import { Writable } from 'node:stream';

import type { TaskEvent } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { CLIConnectorIO, buildRenderOpts } from './connector-io.js';
import { JSONRenderer } from './render/json.js';
import { TerminalRenderer } from './render/terminal.js';
import type {
  AuditRenderReport,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  ShowItem,
} from './render/types.js';

function capture(): { stream: Writable; value: () => string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      data += String(chunk);
      cb();
    },
  });
  return { stream, value: () => data };
}

function makeOpts(stream: Writable, json: boolean): ConnectorRenderOpts {
  return {
    json,
    debug: false,
    noColor: true,
    stream,
    errStream: stream,
  };
}

describe('@no-llm cli/connector-io', () => {
  it('dispatches list payloads to the renderer', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new JSONRenderer());
    const items: ListItem[] = [
      {
        kind: 'workflow',
        name: 'bank-statement',
        stepCount: 5,
        securityClass: 'authenticated',
        modifiedAt: '2026-05-16T12:00:00Z',
      },
    ];
    connector.renderResult({ kind: 'list', items }, makeOpts(stdout.stream, true));
    const parsed = JSON.parse(stdout.value()) as Record<string, unknown>;
    expect(parsed.kind).toBe('list');
    expect(parsed.schemaVersion).toBe('0.1');
    expect(parsed.items as ListItem[]).toHaveLength(1);
  });

  it('dispatches show payloads to the renderer', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer());
    const item: ShowItem = {
      kind: 'workflow',
      name: 'wf',
      yaml: 'name: wf\n',
      locatorCounts: { 'Username field': 3 },
    };
    connector.renderResult({ kind: 'show', item }, makeOpts(stdout.stream, false));
    expect(stdout.value()).toContain('Workflow: wf');
    expect(stdout.value()).toContain('Username field: 3');
  });

  it('dispatches doctor payloads to the renderer', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer());
    const result: DoctorRenderResult = {
      checks: [
        {
          id: 'chrome.detected',
          title: 'Chrome detected',
          status: 'ok',
          summary: 'Chrome 124 found',
        },
      ],
      overall: 'ok',
      version: '0.0.0',
      platform: process.platform,
      nodeVersion: process.versions.node,
    };
    connector.renderResult({ kind: 'doctor', result }, makeOpts(stdout.stream, false));
    expect(stdout.value()).toContain('yantra doctor');
    expect(stdout.value()).toContain('Chrome 124 found');
  });

  it('dispatches audit payloads to the renderer', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer());
    const report: AuditRenderReport = {
      runId: 'run-1',
      workflowName: 'wf',
      status: 'completed',
      startedAt: '2026-05-16T12:00:00Z',
      endedAt: '2026-05-16T12:00:05Z',
      durationMs: 5000,
      llmCallCount: 0,
      secretLookups: [],
      stepCount: 3,
      scopeMix: { publicCount: 3, readOnlyDataCount: 0, authenticatedCount: 0 },
      trustNarrative: 'Run completed in 5.0s. No LLM calls and no secrets.',
    };
    connector.renderResult({ kind: 'audit', report }, makeOpts(stdout.stream, false));
    expect(stdout.value()).toContain('Audit — run run-1');
    expect(stdout.value()).toContain('Run completed in 5.0s');
  });

  it('dispatches report payloads to the renderer', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer());
    connector.renderResult(
      { kind: 'report', markdown: '# Report\n\nAll good.' },
      makeOpts(stdout.stream, false),
    );
    expect(stdout.value()).toContain('# Report');
  });

  it('onEvent disposer is idempotent', () => {
    const connector = new CLIConnectorIO(new JSONRenderer());
    const handler = (_event: TaskEvent): void => undefined;
    const dispose = connector.onEvent(handler);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });

  it('buildRenderOpts forwards flags into the render opts', () => {
    const opts = buildRenderOpts({
      json: true,
      debug: false,
      noLlm: false,
      configPath: null,
      noColor: true,
    });
    expect(opts.json).toBe(true);
    expect(opts.noColor).toBe(true);
    expect(opts.debug).toBe(false);
  });
});
