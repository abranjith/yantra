import { describe, expect, it } from 'vitest';

import {
  buildYantraWrappedTools,
  createYantraTools,
  yantraToolCatalog,
} from '../../src/adapters/pi/tools/index.js';
import { hashToolCatalog } from '../../src/runtime/catalog-hash.js';
import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';
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
