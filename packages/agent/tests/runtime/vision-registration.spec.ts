import { describe, expect, it } from 'vitest';

import {
  buildYantraWrappedTools,
  createYantraTools,
  yantraToolCatalog,
} from '../../src/adapters/pi/tools/index.js';
import { resolveCaptureCapability } from '../../src/runtime/capture-capability.js';
import { hashToolCatalog } from '../../src/runtime/catalog-hash.js';
import {
  COMMAND_TASK_PROFILES,
  INTERACT_TOOLS,
  resolveCommandTaskProfile,
} from '../../src/runtime/profiles.js';
import type { BrowserToolDeps } from '../../src/runtime/run-services.js';
import {
  resolveVisionAvailability,
  type VisionAvailabilityInput,
} from '../../src/runtime/vision.js';
import { buildServices } from '../adapters/pi/tools/test-support.js';

const ALL_TRUE: VisionAvailabilityInput = {
  grantEnabled: true,
  hasBrowserTools: true,
  modelImageInput: true,
  suppressedByFlag: false,
  zeroLlm: false,
};

function names(input: VisionAvailabilityInput): string[] {
  const vision = resolveVisionAvailability(input);
  return buildYantraWrappedTools(buildServices({ vision }), COMMAND_TASK_PROFILES.do).map(
    (tool) => tool.name,
  );
}

describe('@no-llm vision registration gate', () => {
  it('registers browser_screenshot only when all five conditions hold', () => {
    expect(names(ALL_TRUE)).toContain('browser_screenshot');
  });

  it.each([
    ['grant absent or false', { grantEnabled: false }],
    ['one-run suppression', { suppressedByFlag: true }],
    ['scheduled or daemon zero-LLM', { zeroLlm: true }],
    ['nested workflow_run zero-LLM', { zeroLlm: true }],
    ['text-only model', { modelImageInput: false }],
    ['profile without browser tools', { hasBrowserTools: false }],
  ] as const)('keeps the tool structurally absent for %s', (_label, override) => {
    const input = { ...ALL_TRUE, ...override };
    const catalogNames = names(input);
    expect(catalogNames).not.toContain('browser_screenshot');
    expect(catalogNames.some((name) => name.startsWith('SCREENSHOT_'))).toBe(false);
  });

  it.each([
    ['grant absent or false', { grantEnabled: false }, ['grant_missing']],
    ['text-only model', { modelImageInput: false }, ['model_no_image_input']],
    ['profile without browser tools', { hasBrowserTools: false }, ['no_browser_tools']],
    ['one-run suppression', { suppressedByFlag: true }, ['suppressed_by_flag']],
    ['zero-LLM context', { zeroLlm: true }, ['zero_llm']],
  ] as const)('records the reason for %s', (_label, override, reasons) => {
    const vision = resolveVisionAvailability({ ...ALL_TRUE, ...override });
    expect(vision.available).toBe(false);
    expect(vision.reasons).toEqual(reasons);
  });

  it('records no reasons when available, and every reason in order when all fail', () => {
    expect(resolveVisionAvailability(ALL_TRUE).reasons).toEqual([]);
    expect(
      resolveVisionAvailability({
        grantEnabled: false,
        hasBrowserTools: false,
        modelImageInput: false,
        suppressedByFlag: true,
        zeroLlm: true,
      }).reasons,
    ).toEqual([
      'grant_missing',
      'model_no_image_input',
      'no_browser_tools',
      'suppressed_by_flag',
      'zero_llm',
    ]);
  });

  it('keeps the availability truth table unchanged: only all five true enables it', () => {
    const keys = [
      'grantEnabled',
      'hasBrowserTools',
      'modelImageInput',
      'suppressedByFlag',
      'zeroLlm',
    ] as const;
    for (let mask = 0; mask < 32; mask += 1) {
      const input = Object.fromEntries(
        keys.map((key, index) => [key, (mask & (1 << index)) !== 0]),
      ) as unknown as VisionAvailabilityInput;
      const expected =
        input.grantEnabled &&
        input.hasBrowserTools &&
        input.modelImageInput &&
        !input.suppressedByFlag &&
        !input.zeroLlm;
      const vision = resolveVisionAvailability(input);
      expect(vision.available).toBe(expected);
      expect(vision.reasons.length === 0).toBe(expected);
    }
  });

  describe('deliverable capture registration (FEAT-058)', () => {
    // Registration reads only that a browser exists, never its methods.
    const browser = {} as unknown as BrowserToolDeps;

    function catalog(options: {
      readonly vision: VisionAvailabilityInput;
      readonly suppressed?: boolean;
      readonly profile?: Parameters<typeof buildYantraWrappedTools>[1];
      readonly hasBrowser?: boolean;
    }): string[] {
      const vision = resolveVisionAvailability({
        ...options.vision,
        suppressedByFlag: options.suppressed === true,
      });
      const profile = options.profile ?? COMMAND_TASK_PROFILES.do;
      const services = buildServices({
        vision,
        domain: options.hasBrowser === false ? {} : { browser },
        capture: resolveCaptureCapability({
          vision,
          hasBrowser: options.hasBrowser !== false,
          hasInteractionTools: (profile?.toolNames ?? []).some((name) => INTERACT_TOOLS.has(name)),
          suppressedByFlag: options.suppressed === true,
        }),
      });
      return buildYantraWrappedTools(services, profile).map((tool) => tool.name);
    }

    const TEXT_ONLY_NO_GRANT: VisionAvailabilityInput = {
      ...ALL_TRUE,
      grantEnabled: false,
      modelImageInput: false,
    };

    it('registers browser_capture and not browser_screenshot for a grant-less, text-only do run', () => {
      const names = catalog({ vision: TEXT_ONLY_NO_GRANT });
      expect(names).toContain('browser_capture');
      expect(names).not.toContain('browser_screenshot');
    });

    it('registers neither under --no-screenshots', () => {
      const names = catalog({ vision: ALL_TRUE, suppressed: true });
      expect(names).not.toContain('browser_capture');
      expect(names).not.toContain('browser_screenshot');
    });

    it("registers neither for research's read-only browse", () => {
      const names = catalog({
        vision: TEXT_ONLY_NO_GRANT,
        profile: resolveCommandTaskProfile('research', { browse: true }),
      });
      expect(names).not.toContain('browser_capture');
      expect(names).not.toContain('browser_screenshot');
    });

    it('registers neither without a browser', () => {
      expect(catalog({ vision: TEXT_ONLY_NO_GRANT, hasBrowser: false })).not.toContain(
        'browser_capture',
      );
    });

    it('registers both when Vision Assist is enabled', () => {
      const names = catalog({ vision: ALL_TRUE });
      expect(names).toContain('browser_capture');
      expect(names).toContain('browser_screenshot');
      expect(names).toEqual([...names].sort());
    });
  });

  it('keeps Pi tools and the hash catalog on the identical name set', () => {
    for (const available of [false, true]) {
      const vision = resolveVisionAvailability({
        ...ALL_TRUE,
        modelImageInput: available,
      });
      const services = buildServices({ vision });
      const piNames = createYantraTools(services, COMMAND_TASK_PROFILES.do).map(
        (tool) => tool.name,
      );
      const hashNames = yantraToolCatalog(services, COMMAND_TASK_PROFILES.do).map(
        (tool) => tool.name,
      );
      expect(hashNames).toEqual(piNames);
    }
  });

  it('changes the deterministic catalog hash with availability', () => {
    const unavailable = buildServices({
      vision: resolveVisionAvailability({ ...ALL_TRUE, modelImageInput: false }),
    });
    const available = buildServices({ vision: resolveVisionAvailability(ALL_TRUE) });
    expect(hashToolCatalog(yantraToolCatalog(available, COMMAND_TASK_PROFILES.do))).not.toBe(
      hashToolCatalog(yantraToolCatalog(unavailable, COMMAND_TASK_PROFILES.do)),
    );
  });
});
