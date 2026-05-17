// @no-llm
import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect } from 'vitest';

import { diagnoseLocatorMiss } from '../../../src/workflow/replay/frame-diagnostic.js';
import type { FailureDetail } from '../../../src/workflow/replay/types.js';

function makeWorkflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name: 'test-workflow',
    description: null,
    security_class: 'public',
    recorded_with: null,
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

function makeFailure(overrides: Partial<FailureDetail> = {}): FailureDetail {
  return {
    failureClass: 'locator_not_found',
    stepId: 's1',
    message: 'Locator not found',
    locatorName: 'submit-button',
    ...overrides,
  };
}

describe('diagnoseLocatorMiss', () => {
  it('upgrades failureClass when URL origin is in _unrecorded_frames', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['https://oauth.example.com/login'],
    });
    const failure = makeFailure();
    diagnoseLocatorMiss('https://oauth.example.com/callback', workflow, failure);
    expect(failure.failureClass).toBe('locator_miss_in_unrecorded_frame');
  });

  it('updates failure message when upgraded', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['https://oauth.example.com/login'],
    });
    const failure = makeFailure({ locatorName: 'submit-button' });
    diagnoseLocatorMiss('https://oauth.example.com/callback', workflow, failure);
    expect(failure.message).toContain('oauth.example.com');
    expect(failure.message).toContain('submit-button');
  });

  it('does not modify failure when origin is NOT in _unrecorded_frames', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['https://other.example.com/'],
    });
    const failure = makeFailure();
    diagnoseLocatorMiss('https://example.com/', workflow, failure);
    expect(failure.failureClass).toBe('locator_not_found');
  });

  it('does nothing for non-locator_not_found failure class', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['https://oauth.example.com/'],
    });
    const failure = makeFailure({ failureClass: 'network_error' });
    diagnoseLocatorMiss('https://oauth.example.com/callback', workflow, failure);
    expect(failure.failureClass).toBe('network_error');
  });

  it('does nothing when _unrecorded_frames is empty', () => {
    const workflow = makeWorkflow({ _unrecorded_frames: [] });
    const failure = makeFailure();
    diagnoseLocatorMiss('https://oauth.example.com/callback', workflow, failure);
    expect(failure.failureClass).toBe('locator_not_found');
  });

  it('handles malformed currentPageUrl gracefully', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['https://oauth.example.com/'],
    });
    const failure = makeFailure();
    expect(() => diagnoseLocatorMiss('not-a-url', workflow, failure)).not.toThrow();
    expect(failure.failureClass).toBe('locator_not_found');
  });

  it('handles malformed URL in _unrecorded_frames gracefully', () => {
    const workflow = makeWorkflow({
      _unrecorded_frames: ['not-a-url', 'https://oauth.example.com/'],
    });
    const failure = makeFailure();
    diagnoseLocatorMiss('https://oauth.example.com/callback', workflow, failure);
    // Should still match the valid URL entry
    expect(failure.failureClass).toBe('locator_miss_in_unrecorded_frame');
  });
});
