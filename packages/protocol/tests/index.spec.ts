import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  parseSchemaVersion,
  selectValidator,
} from '../src/index.js';

import { makePlan } from './factories.js';

describe('@no-llm protocol smoke', () => {
  it('exports a PROTOCOL_VERSION constant matching the package version', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.0');
  });

  it('exports schema version 0.2 and parses both supported versions', () => {
    expect(SCHEMA_VERSION).toBe('0.2');
    expect(parseSchemaVersion('0.2').isOk).toBe(true);
    expect(parseSchemaVersion('0.1').isOk).toBe(true);
  });

  it('rejects unknown schema versions', () => {
    expect(parseSchemaVersion('0.3').isOk).toBe(false);
    expect(parseSchemaVersion(0.2).isOk).toBe(false);
    expect(parseSchemaVersion(null).isOk).toBe(false);
  });

  it('selectValidator still validates v0.1 plans (additive-bump regression guard)', () => {
    const legacyPlan = makePlan({ schema_version: '0.1' });
    const result = selectValidator(legacyPlan)(legacyPlan);
    expect(result.isOk).toBe(true);
  });

  it('selectValidator validates v0.2 plans', () => {
    const plan = makePlan();
    expect(plan.schema_version).toBe('0.2');
    const result = selectValidator(plan)(plan);
    expect(result.isOk).toBe(true);
  });

  it('exposes PROTOCOL_VERSION as a readonly string literal', () => {
    expect(typeof PROTOCOL_VERSION).toBe('string');
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
