import { COMMAND_REGISTRY, LEAF_COMMAND_IDS } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/program.js';
import { LEGACY_ONLY } from '../../src/registry/handler.js';
import { buildHandlers } from '../../src/registry/handlers.js';
import { UNMIGRATED_COMMANDS } from '../../src/registry/unmigrated.js';

const unmigrated = new Set(UNMIGRATED_COMMANDS.map((item) => item.path));
const topLevelNames = buildProgram().commands.map((command) => command.name());

describe('@no-llm UNMIGRATED_COMMANDS allowlist', () => {
  it('holds well-formed, dated entries owned by FEAT-070', () => {
    for (const item of UNMIGRATED_COMMANDS) {
      expect(item.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(item.since))).toBe(false);
      expect(item.reason.trim().length).toBeGreaterThan(0);
      expect(item.owner).toBe('FEAT-070');
    }
  });

  it('names only real top-level commands, once each', () => {
    const paths = UNMIGRATED_COMMANDS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(topLevelNames).toContain(path);
  });

  it('binds no unmigrated family and leaves no migrated family unbound', () => {
    const handlers = buildHandlers();
    const wrong = LEAF_COMMAND_IDS.filter((id) => {
      const family = id.split('.')[0]!;
      const binding = handlers[id];
      return unmigrated.has(family) ? binding !== LEGACY_ONLY : typeof binding !== 'function';
    });
    expect(wrong).toEqual([]);
  });

  it('gives every migrated family a registry entry', () => {
    const generatedFamilies = topLevelNames.filter((name) => !unmigrated.has(name));
    for (const family of generatedFamilies) {
      expect(COMMAND_REGISTRY.commands.some((entry) => entry.id === family)).toBe(true);
    }
  });
});
