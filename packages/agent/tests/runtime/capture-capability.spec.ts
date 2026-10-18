/** @no-llm FEAT-058 S2/S3: the two capture capabilities and their reason codes. */

import { CaptureCapabilityRecord } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  captureCapabilityRecord,
  resolveCaptureCapability,
  type CaptureCapabilityInput,
} from '../../src/runtime/capture-capability.js';
import {
  COMMAND_TASK_PROFILES,
  INTERACT_TOOLS,
  resolveCommandTaskProfile,
} from '../../src/runtime/profiles.js';
import { resolveVisionAvailability } from '../../src/runtime/vision.js';

const VISION_OFF = resolveVisionAvailability({
  grantEnabled: false,
  hasBrowserTools: true,
  modelImageInput: false,
  suppressedByFlag: false,
  zeroLlm: false,
});

const VISION_ON = resolveVisionAvailability({
  grantEnabled: true,
  hasBrowserTools: true,
  modelImageInput: true,
  suppressedByFlag: false,
  zeroLlm: false,
});

function deliverable(overrides: Partial<CaptureCapabilityInput>) {
  return resolveCaptureCapability({
    vision: VISION_OFF,
    hasBrowser: true,
    hasInteractionTools: true,
    suppressedByFlag: false,
    ...overrides,
  }).deliverable;
}

function hasInteraction(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => INTERACT_TOOLS.has(name));
}

describe('@no-llm deliverable capture decision table', () => {
  it('is available with a browser, interaction tools, and no suppression', () => {
    expect(deliverable({})).toEqual({ available: true, reasons: [] });
  });

  it('records suppressed_by_flag under --no-screenshots', () => {
    expect(deliverable({ suppressedByFlag: true })).toEqual({
      available: false,
      reasons: ['suppressed_by_flag'],
    });
  });

  it('records every failing condition in the fixed order', () => {
    expect(deliverable({ suppressedByFlag: true, hasBrowser: false })).toEqual({
      available: false,
      reasons: ['suppressed_by_flag', 'no_browser'],
    });
    expect(
      deliverable({ suppressedByFlag: true, hasBrowser: false, hasInteractionTools: false }),
    ).toEqual({
      available: false,
      reasons: ['suppressed_by_flag', 'no_browser', 'no_interaction_tools'],
    });
  });

  it("is unavailable for research's read-only browse profile", () => {
    const research = resolveCommandTaskProfile('research', { browse: true });
    expect(deliverable({ hasInteractionTools: hasInteraction(research.toolNames) })).toEqual({
      available: false,
      reasons: ['no_interaction_tools'],
    });
  });

  it('is unavailable for ask, which has no browser tools', () => {
    expect(
      deliverable({
        hasBrowser: false,
        hasInteractionTools: hasInteraction(COMMAND_TASK_PROFILES.ask.toolNames),
      }),
    ).toEqual({ available: false, reasons: ['no_browser', 'no_interaction_tools'] });
  });

  it('is available for do with a browser', () => {
    expect(
      deliverable({ hasInteractionTools: hasInteraction(COMMAND_TASK_PROFILES.do.toolNames) }),
    ).toEqual({ available: true, reasons: [] });
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['undefined', undefined],
  ])('fails closed when an input is %s', (_label, value) => {
    const cast = value as unknown as boolean;
    expect(deliverable({ hasBrowser: cast }).available).toBe(false);
    expect(deliverable({ hasInteractionTools: cast }).available).toBe(false);
    // A suppression flag that is not literally false suppresses.
    expect(deliverable({ suppressedByFlag: cast }).available).toBe(false);
  });

  it('never reads the grant or the model image capability', () => {
    expect(deliverable({ vision: VISION_OFF })).toEqual(deliverable({ vision: VISION_ON }));
  });
});

describe('@no-llm Vision Assist in the capture capability', () => {
  it('mirrors the vision decision and its reasons', () => {
    expect(
      resolveCaptureCapability({
        vision: VISION_ON,
        hasBrowser: true,
        hasInteractionTools: true,
        suppressedByFlag: false,
      }).visionAssist,
    ).toEqual({
      available: true,
      reasons: [],
    });
    expect(
      resolveCaptureCapability({
        vision: VISION_OFF,
        hasBrowser: true,
        hasInteractionTools: true,
        suppressedByFlag: false,
      }).visionAssist,
    ).toEqual({ available: false, reasons: ['grant_missing', 'model_no_image_input'] });
  });

  it('projects to a record the protocol schema accepts', () => {
    const record = captureCapabilityRecord(
      resolveCaptureCapability({
        vision: VISION_OFF,
        hasBrowser: false,
        hasInteractionTools: true,
        suppressedByFlag: true,
      }),
    );

    expect(CaptureCapabilityRecord.parse(record)).toEqual({
      vision_assist: { available: false, reasons: ['grant_missing', 'model_no_image_input'] },
      deliverable: { available: false, reasons: ['suppressed_by_flag', 'no_browser'] },
    });
  });
});
