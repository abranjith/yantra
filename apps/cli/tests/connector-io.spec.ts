import { join } from 'node:path';
import { Writable } from 'node:stream';

import { capabilityGapLine, type AgentProgressEvent, type AgenticTaskOutcome } from '@yantra/agent';
import type { ConfirmationRequest, TaskEvent } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CLIConnectorIO, agentFailureLine, buildRenderOpts } from '../src/connector-io.js';
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
          sentToModel: true,
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
      terminationReason: 'model_finished',
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

describe('@no-llm cli/connector-io task-contract echo (FEAT-052)', () => {
  const declared = (revision: number, summary: string): AgentProgressEvent => ({
    type: 'contract_declared',
    revision,
    summary,
    at: '2026-10-12T12:00:00.000Z',
  });

  function textConnector(): {
    readonly connector: CLIConnectorIO;
    readonly stdout: ReturnType<typeof capture>;
    readonly stderr: ReturnType<typeof capture>;
  } {
    const stdout = capture();
    const stderr = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer(), {
      renderOpts: { ...makeOpts(stdout.stream, false), errStream: stderr.stream },
      interactive: true,
    });
    return { connector, stdout, stderr };
  }

  it('writes the understood line to stderr and nothing to stdout', () => {
    const { connector, stdout, stderr } = textConnector();

    connector.emitAgentEvent(declared(1, 'table of SUV listings — fields: dealer, price'));

    expect(stderr.value()).toBe('understood: table of SUV listings — fields: dealer, price\n');
    expect(stdout.value()).toBe('');
  });

  it('marks a later revision as revised', () => {
    const { connector, stderr } = textConnector();

    connector.emitAgentEvent(declared(1, 'answer of x'));
    connector.emitAgentEvent(declared(2, 'answer of y'));

    expect(stderr.value()).toBe('understood: answer of x\nunderstood (revised): answer of y\n');
  });

  it('strips terminal escape sequences from the summary', () => {
    const { connector, stderr } = textConnector();

    connector.emitAgentEvent(declared(1, 'table of \u001b[31mred\u001b[0m cars\nnext'));

    expect(stderr.value()).not.toContain('\u001b');
    expect(stderr.value().split('\n')).toHaveLength(2);
    expect(stderr.value()).toMatch(/^understood: table of \s?\[31mred \[0m cars next\n$/u);
  });

  it('emits one agent_progress JSON line in JSON mode', () => {
    const stdout = capture();
    const connector = new CLIConnectorIO(new JSONRenderer(), {
      renderOpts: makeOpts(stdout.stream, true),
      interactive: false,
    });

    connector.emitAgentEvent(declared(1, 'answer of x'));

    const lines = stdout.value().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      kind: 'agent_progress',
      event: { type: 'contract_declared', revision: 1, summary: 'answer of x' },
    });
  });
});

describe('@no-llm cli/connector-io capability gap disclosure (FEAT-058)', () => {
  const gap = (
    scope: 'viewport' | 'full_page',
    reason: 'suppressed_by_flag' | 'no_browser',
  ): AgentProgressEvent => ({
    type: 'capability_gap',
    item: `artifact:screenshot:${scope}`,
    reason,
    summary: capabilityGapLine(scope, reason),
    at: '2026-10-16T12:00:00.000Z',
  });

  function connectorFor(json: boolean) {
    const stdout = capture();
    const stderr = capture();
    const connector = new CLIConnectorIO(new TerminalRenderer(), {
      renderOpts: { ...makeOpts(stdout.stream, json), errStream: stderr.stream },
      interactive: true,
    });
    return { connector, stdout, stderr };
  }

  it('writes the suppressed line to stderr, byte-exact, and nothing to stdout', () => {
    const { connector, stdout, stderr } = connectorFor(false);

    connector.emitAgentEvent(gap('viewport', 'suppressed_by_flag'));

    expect(stderr.value()).toBe(
      'Cannot deliver: viewport screenshot. Screenshots are off for this run (--no-screenshots); continuing with the other requirements.\n',
    );
    expect(stdout.value()).toBe('');
  });

  it('writes the no-browser line byte-exact', () => {
    const { connector, stderr } = connectorFor(false);

    connector.emitAgentEvent(gap('full_page', 'no_browser'));

    expect(stderr.value()).toBe(
      'Cannot deliver: full-page screenshot. No browser is available in this run; continuing with the other requirements.\n',
    );
  });

  it('renders only ASCII bytes: no mojibake sequence and no control byte but the newline', () => {
    const { connector, stderr } = connectorFor(false);
    connector.emitAgentEvent(gap('viewport', 'suppressed_by_flag'));
    connector.emitAgentEvent(gap('full_page', 'no_browser'));

    const bytes = Buffer.from(stderr.value(), 'utf8');
    expect(bytes.includes(Buffer.from([0xc3, 0xa2]))).toBe(false);
    expect([...bytes].every((byte) => byte === 0x0a || (byte >= 0x20 && byte < 0x7f))).toBe(true);
  });

  it('emits a structured event under --json', () => {
    const { connector, stdout, stderr } = connectorFor(true);

    connector.emitAgentEvent(gap('viewport', 'suppressed_by_flag'));

    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value().trim())).toMatchObject({
      kind: 'agent_progress',
      event: {
        type: 'capability_gap',
        item: 'artifact:screenshot:viewport',
        reason: 'suppressed_by_flag',
      },
    });
  });
});

describe('@no-llm cli/connector-io task outcome lines (FEAT-054)', () => {
  const brief = {
    kind: 'brief' as const,
    briefId: 'brief-1',
    jsonPath: '/runs/run-1/brief.json',
    markdownPath: '/runs/run-1/brief.md',
    htmlPath: '/runs/run-1/brief.html',
  };
  const fulfilled: AgenticTaskOutcome = {
    kind: 'published',
    runId: 'run-1',
    runDir: '/runs/run-1',
    brief,
    taskOutcome: 'fulfilled',
    requirements: { met: 3, total: 3, unmet: [], contractDeclared: true },
    artifacts: [],
    captureSets: [],
    terminationReason: 'model_finished',
  };
  const partial: AgenticTaskOutcome = {
    ...fulfilled,
    taskOutcome: 'partial',
    requirements: {
      met: 2,
      total: 4,
      unmet: [
        { id: 'fill', label: 'fill all eligible fields', reason: 'fields 10 of 48 filled' },
        {
          id: 'artifact:screenshot:viewport',
          label: 'viewport screenshot',
          reason: 'not captured (no browser was available)',
        },
      ],
      contractDeclared: true,
    },
    terminationReason: 'wall-clock-soft',
  };

  function render(outcome: AgenticTaskOutcome, json = false, suppress = false) {
    const stdout = capture();
    const stderr = capture();
    const connector = new CLIConnectorIO(new JSONRenderer(), {
      renderOpts: { ...makeOpts(stdout.stream, json), errStream: stderr.stream },
      interactive: false,
      ...(suppress ? { suppressPublishedOutcome: true } : {}),
    });
    connector.renderAgentOutcome(outcome);
    return { stdout: stdout.value(), stderr: stderr.value() };
  }

  it('prints the fulfilled first line and the run id on stdout', () => {
    expect(render(fulfilled)).toEqual({
      stdout: '\nFulfilled: 3 of 3 requirements met. Brief: /runs/run-1/brief.html\nRun: run-1\n',
      stderr: '',
    });
  });

  it('prints the partial first line naming the unmet items', () => {
    expect(render(partial).stdout).toBe(
      '\nPartial: 2 of 4 requirements met; fields 10 of 48 filled; viewport screenshot not captured (no browser was available). Brief: /runs/run-1/brief.html\nRun: run-1\n',
    );
  });

  it('prints Fulfilled without a count for ask and research', () => {
    expect(render({ ...fulfilled, requirements: null }).stdout).toBe(
      '\nFulfilled. Brief: /runs/run-1/brief.html\nRun: run-1\n',
    );
  });

  const SHA = 'f'.repeat(64);
  function captureSet(
    seq: number,
    parts = 1,
    extra: Partial<{
      complete: boolean;
      labels: ('truncated' | 'clipped_width' | 'beyond_viewport')[];
    }> = {},
  ) {
    return {
      scope: parts > 1 ? ('full_page' as const) : ('viewport' as const),
      parts: Array.from({ length: parts }, (_, index) => ({
        path: `screenshots/capture-${seq}-${SHA.slice(0, 12)}${parts > 1 ? `-p${index + 1}` : ''}.png`,
        sha256: SHA,
        bytes: 100,
        width: 1280,
        height: parts > 1 ? 4096 : 720,
        part: index + 1,
      })),
      complete: extra.complete ?? true,
      labels: extra.labels ?? [],
    };
  }
  function withSets(sets: ReturnType<typeof captureSet>[]): AgenticTaskOutcome {
    return {
      ...fulfilled,
      captureSets: sets,
      artifacts: sets.flatMap((set) =>
        set.parts.map((part) => ({
          kind: 'screenshot' as const,
          path: part.path,
          sha256: part.sha256,
          mime_type: 'image/png' as const,
          bytes: part.bytes,
          width: part.width,
          height: part.height,
          sent_to_model: false,
        })),
      ),
    };
  }
  const shot = (seq: number, suffix = '') =>
    join('/runs/run-1', 'screenshots', `capture-${seq}-${SHA.slice(0, 12)}${suffix}.png`);

  it('prints one Screenshot line under the first line for a fulfilled capture', () => {
    expect(render(withSets([captureSet(1)])).stdout).toBe(
      '\nFulfilled: 3 of 3 requirements met. Brief: /runs/run-1/brief.html\n' +
        `Screenshot: ${shot(1)}\n` +
        'Run: run-1\n',
    );
  });

  it('labels a tiled, truncated set as part 1 of n and incomplete', () => {
    const out = render(
      withSets([captureSet(1, 6, { complete: false, labels: ['truncated'] })]),
    ).stdout;
    expect(out).toContain(`Screenshot: ${shot(1, '-p1')} (part 1 of 6) (incomplete: truncated)\n`);
  });

  it('prints at most three Screenshot lines, then counts the rest', () => {
    const out = render(withSets([1, 2, 3, 4, 5].map((seq) => captureSet(seq)))).stdout;
    const lines = out.split('\n').filter((line) => line.startsWith('Screenshot: '));
    expect(lines).toEqual([1, 2, 3].map((seq) => `Screenshot: ${shot(seq)}`));
    expect(out).toContain(`+2 more in ${join('/runs/run-1', 'screenshots')}\n`);
  });

  it('adds run-relative artifact references to the JSON record', () => {
    const record = JSON.parse(render(withSets([captureSet(1, 2)]), true).stdout) as {
      artifacts: { path: string; sent_to_model: boolean }[];
    };
    expect(record.artifacts.map((artifact) => artifact.path)).toEqual([
      `screenshots/capture-1-${SHA.slice(0, 12)}-p1.png`,
      `screenshots/capture-1-${SHA.slice(0, 12)}-p2.png`,
    ]);
    expect(record.artifacts.every((artifact) => !artifact.sent_to_model)).toBe(true);
  });

  it('renders the capture lines in printable ASCII only', () => {
    const out = render(
      withSets([captureSet(1, 3, { complete: false, labels: ['clipped_width'] }), captureSet(2)]),
    ).stdout;
    const lines = out.split('\n').filter((line) => line.startsWith('Screenshot: '));
    const bytes = Buffer.from(lines.join('\n'), 'utf8');
    expect(bytes.includes(Buffer.from([0xc3, 0xa2]))).toBe(false);
    expect([...bytes].every((byte) => byte === 0x0a || (byte >= 0x20 && byte < 0x7f))).toBe(true);
  });

  it('keeps handoff and failure text on stderr unchanged', () => {
    expect(
      render({
        kind: 'handoff',
        runId: 'run-1',
        runDir: '/runs/run-1',
        blocker: 'CAPTCHA',
        safestNextAction: 'Complete it manually.',
        terminationReason: 'handoff',
      }),
    ).toEqual({
      stdout: '',
      stderr: '\nHuman handoff required: CAPTCHA\nSafest next action: Complete it manually.\n',
    });
  });

  it('carries task_outcome and termination_reason in the JSON record', () => {
    const record = JSON.parse(render(partial, true).stdout) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual([
      'schemaVersion',
      'kind',
      'task_outcome',
      'termination_reason',
      'artifacts',
      'outcome',
    ]);
    expect(record).toMatchObject({
      kind: 'agent_outcome',
      task_outcome: 'partial',
      termination_reason: 'wall-clock-soft',
    });
  });

  it('writes nothing for a suppressed published outcome', () => {
    expect(render(partial, false, true)).toEqual({ stdout: '', stderr: '' });
    expect(render(partial, true, true)).toEqual({ stdout: '', stderr: '' });
  });

  it('leads ask and research failure lines with the outcome word', () => {
    expect(
      agentFailureLine({
        kind: 'failed',
        runId: 'r',
        runDir: '/r',
        error: { code: 'AGENT_COMPLETION_MISSING', message: 'No publication.' },
        terminationReason: 'model_finished',
      }),
    ).toBe('Failed: AGENT_COMPLETION_MISSING: No publication.');
    expect(
      agentFailureLine({
        kind: 'budget_exhausted',
        runId: 'r',
        runDir: '/r',
        error: { code: 'AGENT_BUDGET_EXHAUSTED', message: 'Used.' },
        terminationReason: 'tool-budget',
      }),
    ).toBe('Failed: AGENT_BUDGET_EXHAUSTED: Used.');
    expect(
      agentFailureLine({
        kind: 'handoff',
        runId: 'r',
        runDir: '/r',
        blocker: 'Sign-in needed',
        safestNextAction: 'Sign in',
        terminationReason: 'handoff',
      }),
    ).toBe('Handoff: Sign-in needed: Sign in');
    expect(
      agentFailureLine({
        kind: 'aborted',
        runId: 'r',
        runDir: '/r',
        error: { code: 'AGENT_ABORTED', message: 'Interrupted.' },
        terminationReason: 'user_abort',
      }),
    ).toBe('Aborted: AGENT_ABORTED: Interrupted.');
  });
});
