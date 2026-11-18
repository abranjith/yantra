import { describe, expect, it } from 'vitest';

import {
  CLI_READ_OUTPUT_SCHEMAS,
  ConfigPathResult,
  DaemonStatusResult,
  SchedulesResult,
} from '../../src/index.js';

const FIXTURES: Readonly<Record<keyof typeof CLI_READ_OUTPUT_SCHEMAS, unknown>> = {
  ConfigPathResult: {
    schemaVersion: '0.2',
    kind: 'config.path',
    rows: [{ name: 'home', path: '/x', source: 'default' }],
  },
  ConfigListResult: { schemaVersion: '0.2', kind: 'config.list', config: {} },
  ConfigGetResult: { schemaVersion: '0.2', kind: 'config.get', key: 'x', value: 1 },
  ConfigValidateResult: {
    schemaVersion: '0.2',
    kind: 'config.validate',
    valid: true,
    path: '/x/config.yaml',
  },
  ModelListResult: { schemaVersion: '0.2', kind: 'model.list', rows: [] },
  SitesListResult: { schemaVersion: '0.2', kind: 'sites', rows: [] },
  BrowserListResult: {
    schemaVersion: '0.2',
    kind: 'browser_list',
    selection: { source: 'auto', executablePath: null, origin: 'default' },
    effective: { status: 'unavailable' },
    managed: {},
  },
  TemplateListResult: { schemaVersion: '0.2', kind: 'template_list', tag: null, items: [] },
  TemplateShowResult: {
    schemaVersion: '0.2',
    kind: 'template_show',
    name: 'x',
    path: '/x.md',
    markdown: '',
    template: { name: 'x', description: null, guidance: null, tags: [], hash: 'h', slotCount: 0 },
    slots: [],
  },
  ShowResult: {
    schemaVersion: '0.2',
    kind: 'show',
    item: { kind: 'workflow', name: 'x', yaml: '{}', locatorCounts: {} },
  },
  SchedulesResult: [],
  UsageResult: {
    schemaVersion: '0.2',
    kind: 'usage',
    rows: [],
    totals: { taskCount: 0, totalCostUsd: 0 },
  },
  DaemonStatusResult: {
    running: false,
    pid: null,
    schedulesLoaded: 0,
    nextFires: [],
    pendingConfirmations: 0,
  },
  ProfileResult: {
    schemaVersion: '0.2',
    kind: 'profile',
    profilePath: '/profile.yaml',
    preferences: [],
  },
  PrefsResult: { schemaVersion: '0.2', kind: 'prefs', rows: [] },
};

describe('@no-llm generated-surface CLI read schemas', () => {
  it('parses one representative document for every schema', () => {
    for (const [name, schema] of Object.entries(CLI_READ_OUTPUT_SCHEMAS)) {
      expect(schema.safeParse(FIXTURES[name as keyof typeof FIXTURES]).success).toBe(true);
    }
  });

  it('requires schemaVersion on every envelope', () => {
    for (const [name, schema] of Object.entries(CLI_READ_OUTPUT_SCHEMAS)) {
      if (schema === SchedulesResult || schema === DaemonStatusResult) continue;
      const fixture = { ...(FIXTURES[name as keyof typeof FIXTURES] as Record<string, unknown>) };
      delete fixture.schemaVersion;
      expect(schema.safeParse(fixture).success).toBe(false);
    }
  });

  it('describes every config-path field for generated documentation', () => {
    expect(ConfigPathResult.description).toContain('config path');
    expect(ConfigPathResult.shape.rows.description).toBeTruthy();
  });
});
