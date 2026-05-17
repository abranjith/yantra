// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect, vi } from 'vitest';

import { checkChromeDrift } from '../../../src/workflow/replay/chrome-drift.js';
import type { RunManifest } from '../../../src/workflow/replay/types.js';

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-001',
    taskId: 'TASK001',
    workflowName: 'test-workflow',
    workflowVersion: 1,
    params: {},
    startedAt: new Date().toISOString(),
    endedAt: undefined,
    status: 'running',
    durationMs: undefined,
    failureClass: undefined,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name: 'test-workflow',
    description: null,
    security_class: 'public',
    recorded_with: { chrome_major: 128, yantra_version: '0.1.0' },
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
    ...overrides,
  };
}

function makeEvents() {
  const published: unknown[] = [];
  return {
    events: published,
    bus: {
      publish: vi.fn((evt: unknown) => {
        published.push(evt);
      }),
      flush: vi.fn(() => Promise.resolve()),
      persistedAt: vi.fn(() => ''),
      close: vi.fn(() => Promise.resolve()),
    },
  };
}

describe('checkChromeDrift', () => {
  it('returns no drift when versions match exactly', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 128, yantra_version: '0.1.0' },
    });
    const { bus } = makeEvents();
    const result = checkChromeDrift(128, workflow, manifest, bus);
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toBe(0);
    expect(bus.publish).not.toHaveBeenCalled();
    expect(manifest.chromeDriftWarning).toBeUndefined();
  });

  it('returns no drift when |diff| = 2', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 126, yantra_version: '0.1.0' },
    });
    const { bus } = makeEvents();
    const result = checkChromeDrift(128, workflow, manifest, bus);
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toBe(2);
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('detects drift when |diff| = 3', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 125, yantra_version: '0.1.0' },
    });
    const { bus } = makeEvents();
    const result = checkChromeDrift(128, workflow, manifest, bus);
    expect(result.hasDrift).toBe(true);
    expect(result.drift).toBe(3);
    expect(result.recorded).toBe(125);
    expect(result.current).toBe(128);
  });

  it('mutates manifest when drift detected', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 100, yantra_version: '0.1.0' },
    });
    const { bus } = makeEvents();
    checkChromeDrift(128, workflow, manifest, bus);
    expect(manifest.chromeDriftWarning).toEqual({ recorded: 100, current: 128 });
  });

  it('publishes chrome_drift_warning event when drift detected', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 100, yantra_version: '0.1.0' },
    });
    const { bus, events } = makeEvents();
    checkChromeDrift(128, workflow, manifest, bus);
    expect(bus.publish).toHaveBeenCalledOnce();
    const evt = events[0] as {
      kind: string;
      recorded_chrome_major: number;
      current_chrome_major: number;
    };
    expect(evt.kind).toBe('chrome_drift_warning');
    expect(evt.recorded_chrome_major).toBe(100);
    expect(evt.current_chrome_major).toBe(128);
  });

  it('skips silently when recorded_with is null', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({ recorded_with: null });
    const { bus } = makeEvents();
    const result = checkChromeDrift(128, workflow, manifest, bus);
    expect(result.hasDrift).toBe(false);
    expect(result.recorded).toBeNull();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(manifest.chromeDriftWarning).toBeUndefined();
  });

  it('detects drift for negative diff (older browser)', () => {
    const manifest = makeManifest();
    const workflow = makeWorkflow({
      recorded_with: { chrome_major: 131, yantra_version: '0.1.0' },
    });
    const { bus } = makeEvents();
    const result = checkChromeDrift(128, workflow, manifest, bus);
    expect(result.hasDrift).toBe(true); // |131 - 128| = 3 > 2 → hasDrift!
    expect(result.drift).toBe(3);
  });
});
