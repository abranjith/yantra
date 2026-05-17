// @no-llm
import { describe, it, expect } from 'vitest';

import {
  renderRunReport,
  renderJsonSummary,
} from '../../../src/workflow/replay/report-renderer.js';
import type { RunManifest, RunReport } from '../../../src/workflow/replay/types.js';

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-001',
    taskId: 'TASK001',
    workflowName: 'test-workflow',
    workflowVersion: 1,
    params: {},
    startedAt: '2026-05-11T09:12:34.000Z',
    endedAt: '2026-05-11T09:12:45.000Z',
    status: 'completed',
    durationMs: 11000,
    failureClass: undefined,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  };
}

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    manifest: makeManifest(),
    stepLog: [
      { stepId: 's1', type: 'navigate', status: 'ok', durationMs: 500 },
      { stepId: 's2', type: 'click', status: 'ok', durationMs: 200 },
    ],
    outputs: {
      persisted: { title: 'Home Page' },
      transient: {},
      errors: [],
    },
    failure: undefined,
    auditEntries: [],
    ...overrides,
  };
}

describe('renderRunReport', () => {
  it('includes the run ID in the header', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).toContain('run-001');
  });

  it('includes a Summary section', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).toContain('## Run Report');
  });

  it('includes a Steps section', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).toContain('## Steps');
    expect(md).toContain('s1');
    expect(md).toContain('navigate');
  });

  it('includes an Outputs section', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).toContain('## Outputs');
    expect(md).toContain('title');
  });

  it('includes an Audit section', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).toContain('## Audit');
  });

  it('appends resume footer for failed runs', () => {
    const report = makeReport({
      manifest: makeManifest({ status: 'failed', failureClass: 'locator_not_found' }),
    });
    const md = renderRunReport(report);
    expect(md).toContain('yantra resume run-001');
  });

  it('appends resume footer for paused runs', () => {
    const report = makeReport({
      manifest: makeManifest({ status: 'paused' }),
    });
    const md = renderRunReport(report);
    expect(md).toContain('yantra resume run-001');
  });

  it('does NOT append resume footer for completed runs', () => {
    const report = makeReport();
    const md = renderRunReport(report);
    expect(md).not.toContain('yantra resume');
  });

  it('includes chrome drift warning when present', () => {
    const report = makeReport({
      manifest: makeManifest({
        chromeDriftWarning: { recorded: 125, current: 128 },
      }),
    });
    const md = renderRunReport(report);
    expect(md).toContain('Chrome drift');
    expect(md).toContain('125');
    expect(md).toContain('128');
  });

  it('includes failure detail section for failed runs', () => {
    const report = makeReport({
      manifest: makeManifest({ status: 'failed', failureClass: 'locator_not_found' }),
      failure: {
        failureClass: 'locator_not_found',
        stepId: 's2',
        message: 'Could not find #submit',
        locatorName: 'submit-btn',
      },
    });
    const md = renderRunReport(report);
    expect(md).toContain('## Failure Detail');
    expect(md).toContain('locator_not_found');
    expect(md).toContain('#submit');
  });

  it('does not include secrets in output section', () => {
    const report = makeReport({
      outputs: {
        persisted: { apiKey: '<redacted:secret-shape>' },
        transient: {},
        errors: [],
      },
    });
    const md = renderRunReport(report);
    // The redacted sentinel should appear, not a real key
    expect(md).toContain('redacted');
    expect(md).not.toContain('sk-');
  });
});

describe('renderJsonSummary', () => {
  it('returns correct runId and workflowName', () => {
    const report = makeReport();
    const json = renderJsonSummary(report);
    expect(json.runId).toBe('run-001');
    expect(json.workflowName).toBe('test-workflow');
  });

  it('returns correct status and duration', () => {
    const report = makeReport();
    const json = renderJsonSummary(report);
    expect(json.status).toBe('completed');
    expect(json.durationMs).toBe(11000);
  });

  it('counts steps correctly', () => {
    const report = makeReport();
    const json = renderJsonSummary(report);
    expect(json.stepCount).toBe(2);
    expect(json.failedSteps).toBe(0);
  });

  it('counts failed steps', () => {
    const report = makeReport({
      stepLog: [
        { stepId: 's1', type: 'navigate', status: 'ok' },
        { stepId: 's2', type: 'click', status: 'failed', error: 'not found' },
      ],
    });
    const json = renderJsonSummary(report);
    expect(json.failedSteps).toBe(1);
  });

  it('returns output names as array of strings', () => {
    const report = makeReport({
      outputs: {
        persisted: { title: 'Home', count: 42 },
        transient: {},
        errors: [],
      },
    });
    const json = renderJsonSummary(report);
    expect(json.outputs).toContain('title');
    expect(json.outputs).toContain('count');
  });

  it('returns empty outputs array when no outputs', () => {
    const report = makeReport({ outputs: undefined });
    const json = renderJsonSummary(report);
    expect(json.outputs).toEqual([]);
  });
});
