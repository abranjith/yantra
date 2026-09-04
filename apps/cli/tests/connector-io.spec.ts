import { Writable } from 'node:stream';

import type { AgentProgressEvent } from '@yantra/agent';
import type { ConfirmationRequest, TaskEvent } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CLIConnectorIO, buildRenderOpts } from '../src/connector-io.js';
import { JSONRenderer } from '../src/render/json.js';
import { TerminalRenderer } from '../src/render/terminal.js';
import type {
  AuditRenderReport,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  ShowItem,
} from '../src/render/types.js';

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
    expect(parsed.schemaVersion).toBe('0.2');
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
      version: '0.0.1',
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
      agent: null,
      toolCalls: [],
      captures: [],
      rawSessionLogCaptureBearing: false,
      usage: null,
      terminalError: null,
    };
    connector.renderResult({ kind: 'audit', report }, makeOpts(stdout.stream, false));
    expect(stdout.value()).toContain('Audit — run run-1');
    expect(stdout.value()).toContain('Run completed in 5.0s');
  });

  it('renders capture disclosures in terminal and structured JSON output', () => {
    const captureReport: AuditRenderReport = {
      runId: 'capture-run',
      workflowName: 'do',
      status: 'completed',
      startedAt: '2026-09-03T12:00:00Z',
      endedAt: null,
      durationMs: null,
      llmCallCount: 1,
      secretLookups: [],
      stepCount: 0,
      scopeMix: { publicCount: 0, readOnlyDataCount: 0, authenticatedCount: 0 },
      trustNarrative: 'Run completed.',
      agent: {
        adapter: 'pi-coding-agent',
        sdkVersion: '0.80.6',
        provider: 'anthropic',
        model: 'vision-model',
        thinking: 'off',
        authSource: 'managed',
        sessionId: 'capture-session',
        sessionFile: 'agent/capture-session.jsonl',
        promptVersion: 'agent-v8',
      },
      toolCalls: [],
      captures: [
        {
          path: 'screenshots/1-capture.png',
          sha256: 'e'.repeat(64),
          mimeType: 'image/png',
          width: 640,
          height: 480,
          bytes: 8192,
          toolCall: { seq: 1, callId: 'capture-call', tool: 'browser_screenshot' },
          budgetConsumed: { captures: 1, pixels: 307_200, bytes: 8192 },
        },
      ],
      rawSessionLogCaptureBearing: true,
      usage: null,
      terminalError: null,
    };
    const terminal = capture();
    new TerminalRenderer().renderAudit(captureReport, makeOpts(terminal.stream, false));
    expect(terminal.value()).toContain('The model saw these images');
    expect(terminal.value()).toContain('screenshots/1-capture.png');
    expect(terminal.value()).toContain('contains the image data itself');

    const json = capture();
    new JSONRenderer().renderAudit(captureReport, makeOpts(json.stream, true));
    expect(JSON.parse(json.value())).toMatchObject({
      kind: 'audit',
      rawSessionLogCaptureBearing: true,
      captures: [{ path: 'screenshots/1-capture.png', bytes: 8192 }],
    });
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

  it('renders a scripted agent sequence without exposing raw tool payloads', () => {
    const stdout = capture();
    const opts = makeOpts(stdout.stream, false);
    const connector = new CLIConnectorIO(new TerminalRenderer(), {
      renderOpts: opts,
      interactive: true,
    });
    const sequence: AgentProgressEvent[] = [
      { type: 'assistant_text', text: 'Checking sources. ', at: '2026-07-14T12:00:00.000Z' },
      {
        type: 'tool_started',
        tool: 'web_fetch',
        summary: 'fields: url',
        at: '2026-07-14T12:00:01.000Z',
      },
      {
        type: 'tool_finished',
        tool: 'web_fetch',
        summary: 'ok',
        status: 'ok',
        durationMs: 25,
        at: '2026-07-14T12:00:01.025Z',
      },
    ];

    for (const event of sequence) connector.emitAgentEvent(event);

    expect(stdout.value()).toMatchInlineSnapshot(`
      "Checking sources. 
      [web_fetch] fields: url
      [web_fetch] ok â€” ok (25ms)
      "
    `);
    expect(stdout.value()).not.toContain('secret-value');
  });

  it('emits parseable NDJSON for progress and the terminal outcome', () => {
    const stdout = capture();
    const opts = makeOpts(stdout.stream, true);
    const connector = new CLIConnectorIO(new JSONRenderer(), {
      renderOpts: opts,
      interactive: false,
    });

    connector.emitAgentEvent({
      type: 'tool_started',
      tool: 'web_search',
      summary: 'fields: query',
      at: '2026-07-14T12:00:00.000Z',
    });
    connector.renderAgentOutcome({
      kind: 'failed',
      runId: 'run-1',
      runDir: '/runs/run-1',
      error: { code: 'AGENT_COMPLETION_MISSING', message: 'No publication.' },
    });

    const lines = stdout
      .value()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string });
    expect(lines.map((line) => line.kind)).toEqual(['agent_progress', 'agent_outcome']);
  });

  it('fails closed without prompting when the connector is non-interactive', async () => {
    const stdout = capture();
    const prompt = vi.fn(() => Promise.resolve<'granted'>('granted'));
    const connector = new CLIConnectorIO(new JSONRenderer(), {
      renderOpts: makeOpts(stdout.stream, true),
      interactive: false,
      confirmationPrompt: prompt,
    });
    const request: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 'click:1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Submit',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: '2026-07-14T12:00:00.000Z',
      timeout_ms: 1000,
    };

    await expect(
      connector.requestConfirmation(request, new AbortController().signal),
    ).resolves.toBe('denied');
    expect(prompt).not.toHaveBeenCalled();
  });
});
