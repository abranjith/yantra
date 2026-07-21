import type { LintReport } from '@yantra/core';
import type { WorkflowFile, WorkflowStep, Result } from '@yantra/protocol';
import { ok, err } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  validateRegistration,
  type WorkflowLoader,
} from '../../src/commands/schedule-registration.js';

/** Builds a fully-typed navigate WorkflowStep (all optional fields present). */
function navigate(id: string, url: string): WorkflowStep {
  return {
    id,
    verb: 'navigate',
    url,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
  };
}

/** Builds a fully-typed fill WorkflowStep. */
function fill(id: string, locator: string, value: string): WorkflowStep {
  return {
    id,
    verb: 'fill',
    locator,
    value,
    submit: false,
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
  };
}

function makeWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name: 'demo',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [navigate('s1', 'https://example.com')],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
    ...overrides,
  };
}

/** A loader that returns a fixed workflow (or a not-found error). */
function loaderFor(workflow: WorkflowFile | null): WorkflowLoader {
  return {
    load: (name: string): Promise<Result<WorkflowFile, LintReport>> => {
      if (workflow?.name !== name) {
        return Promise.resolve(err<LintReport>({ errors: [], warnings: [], infos: [] }));
      }
      return Promise.resolve(ok(workflow));
    },
  };
}

const FIXED_NOW = new Date('2026-07-05T00:02:30.000Z');

describe('@no-llm validateRegistration', () => {
  it('accepts a valid registration and seeds the next fire', async () => {
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: '*/5 * * * *',
        params: [],
        notifyTarget: 'desktop',
        now: FIXED_NOW,
      },
      loaderFor(makeWorkflow()),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registration).toMatchObject({
        workflowName: 'demo',
        cronExpr: '*/5 * * * *',
        params: {},
        notifyTarget: 'desktop',
        nextFireAt: '2026-07-05T00:05:00.000Z',
      });
    }
  });

  it('rejects an invalid cron expression', async () => {
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: 'not a cron',
        params: [],
        notifyTarget: 'desktop',
      },
      loaderFor(makeWorkflow()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Invalid cron');
    }
  });

  it('rejects an unknown workflow', async () => {
    const result = await validateRegistration(
      {
        workflowName: 'ghost',
        cronExpr: '0 * * * *',
        params: [],
        notifyTarget: 'desktop',
      },
      loaderFor(makeWorkflow()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not found');
    }
  });

  it('rejects a workflow with lint errors', async () => {
    // A `fill` whose literal value is a JWT-shaped credential is a lint error.
    const dirty = makeWorkflow({
      steps: [
        navigate('s1', 'https://example.com'),
        fill('s2', 'Token field', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456'),
      ],
      _locators: { 'Token field': [{ kind: 'role', role: 'textbox', name: 'Token' }] },
    });
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: '0 * * * *',
        params: [],
        notifyTarget: 'desktop',
      },
      loaderFor(dirty),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('lint errors');
    }
  });

  it('rejects a missing required param', async () => {
    const wf = makeWorkflow({
      params: { month: { type: 'string', required: true, example: null } },
    });
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: '0 * * * *',
        params: [],
        notifyTarget: 'desktop',
      },
      loaderFor(wf),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a credential-shaped param value', async () => {
    const wf = makeWorkflow({
      params: { token: { type: 'string', required: false, example: null } },
    });
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: '0 * * * *',
        params: [{ key: 'token', rawValue: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' }],
        notifyTarget: 'desktop',
      },
      loaderFor(wf),
    );
    expect(result.ok).toBe(false);
  });

  it('coerces and stores valid params as strings', async () => {
    const wf = makeWorkflow({
      params: { month: { type: 'string', required: true, example: null } },
    });
    const result = await validateRegistration(
      {
        workflowName: 'demo',
        cronExpr: '0 * * * *',
        params: [{ key: 'month', rawValue: '2026-04' }],
        notifyTarget: 'file',
        now: FIXED_NOW,
      },
      loaderFor(wf),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registration.params).toEqual({ month: '2026-04' });
      expect(result.registration.notifyTarget).toBe('file');
    }
  });
});
