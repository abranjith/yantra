import { DOCTOR_CHECK_IDS, type DoctorCheck } from '@yantra/protocol';
import { COMMAND_REGISTRY, executionClassFor, findLeaf } from '@yantra/protocol/commands';
import { describe, expect, it } from 'vitest';

import { routeTree } from '../../../src/app/router.js';
import {
  REMEDIATION_CATALOG,
  REMEDIATION_ROUTE_PATHS,
  resolveRemediations,
} from '../../../src/surfaces/health/remediations.js';

function findRouteByPath(path: string) {
  const children = (routeTree as unknown as { children?: readonly unknown[] }).children ?? [];
  return children.find(
    (child) => (child as { options?: { path?: string } }).options?.path === path,
  ) as
    | {
        options?: {
          path?: string;
          validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
        };
      }
    | undefined;
}

describe('@no-llm Health REMEDIATION_CATALOG', () => {
  it('covers every DoctorCheckId with at least one entry', () => {
    const covered = new Set(REMEDIATION_CATALOG.map((entry) => entry.check));
    for (const id of DOCTOR_CHECK_IDS) {
      expect(covered.has(id)).toBe(true);
    }
  });

  it('has unique entry IDs and non-empty evidence on every entry', () => {
    const ids = new Set<string>();
    for (const entry of REMEDIATION_CATALOG) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.evidence.trim().length).toBeGreaterThan(0);
    }
  });

  it('resolves every invoke path in the FEAT-062 registry with class run, read, or exclusive', () => {
    for (const entry of REMEDIATION_CATALOG) {
      if (entry.action.kind !== 'invoke') continue;
      const leaf = findLeaf(entry.action.path, COMMAND_REGISTRY);
      expect(leaf).toBeDefined();
      const execClass = executionClassFor(leaf!, { options: {}, arguments: {} });
      expect(['run', 'read', 'exclusive']).toContain(execClass);
      expect(execClass).not.toBe('exemption');
    }
  });

  it('resolves every navigate route in the app route tree with params accepted by validateSearch', () => {
    for (const entry of REMEDIATION_CATALOG) {
      if (entry.action.kind !== 'navigate') continue;
      const path = REMEDIATION_ROUTE_PATHS[entry.action.route];
      const route = findRouteByPath(path);
      expect(route).toBeDefined();
      const validateSearch = route?.options?.validateSearch;
      expect(validateSearch).toBeTypeOf('function');
      const validated = validateSearch!(entry.action.params);
      for (const [key, value] of Object.entries(entry.action.params)) {
        expect(validated[key]).toBe(value);
      }
    }
  });

  it('never names an unknown CLI command in any entry label', () => {
    const cliMention = /yantra\s+([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?)/giu;
    for (const entry of REMEDIATION_CATALOG) {
      for (const match of entry.label.matchAll(cliMention)) {
        const tokens = match[1]!.trim().split(/\s+/u);
        const found =
          findLeaf(tokens, COMMAND_REGISTRY) ?? findLeaf([tokens[0]!], COMMAND_REGISTRY);
        expect(found).toBeDefined();
      }
    }
  });

  it('matches targeted fixture checks and no others', () => {
    const unverifiedBrowser: DoctorCheck = {
      id: 'browser.compatibility',
      title: 'Browser compatibility',
      status: 'warn',
      summary: 'Unverified',
      details: { compatibility: 'unverified' },
    };
    const failedBrowser: DoctorCheck = {
      id: 'browser.compatibility',
      title: 'Browser compatibility',
      status: 'fail',
      summary: 'Failed capabilities',
      details: { compatibility: 'failed' },
    };
    expect(resolveRemediations(unverifiedBrowser).map((r) => r.id)).toEqual([
      'browser.compatibility.check',
    ]);
    expect(resolveRemediations(failedBrowser)).toEqual([]);

    const absentManaged: DoctorCheck = {
      id: 'browser.managed',
      title: 'Managed browser',
      status: 'ok',
      summary: 'Absent',
      details: { status: 'absent' },
    };
    const readyManaged: DoctorCheck = {
      id: 'browser.managed',
      title: 'Managed browser',
      status: 'ok',
      summary: 'Ready',
      details: { status: 'ready' },
    };
    expect(resolveRemediations(absentManaged).map((r) => r.id)).toEqual([
      'browser.managed.install',
    ]);
    expect(resolveRemediations(readyManaged)).toEqual([]);

    const scrapeSearch: DoctorCheck = {
      id: 'search.provider',
      title: 'Search provider',
      status: 'warn',
      summary: 'Scraped search',
      details: { provider: 'duckduckgo', kind: 'scrape', via: 'auto' },
    };
    const apiSearch: DoctorCheck = {
      id: 'search.provider',
      title: 'Search provider',
      status: 'ok',
      summary: 'API search',
      details: { provider: 'tavily', kind: 'api', via: 'config' },
    };
    expect(resolveRemediations(scrapeSearch).map((r) => r.id)).toEqual([
      'search.provider.scrape.tavily',
      'search.provider.scrape.brave',
    ]);
    expect(resolveRemediations(apiSearch)).toEqual([]);

    const profileBudgetFail: DoctorCheck = {
      id: 'agent.budgets',
      title: 'Agent budgets',
      status: 'fail',
      summary: 'Invalid budget',
      details: {
        invalid: [
          {
            setting: 'max_tokens',
            value: -1,
            source: 'profile',
            preferenceKey: 'agent.max_tokens',
          },
        ],
      },
    };
    const envBudgetFail: DoctorCheck = {
      id: 'agent.budgets',
      title: 'Agent budgets',
      status: 'fail',
      summary: 'Invalid env budget',
      details: {
        invalid: [
          {
            setting: 'max_duration',
            value: 'bad',
            source: 'env',
            envVar: 'YANTRA_AGENT_MAX_DURATION',
            preferenceKey: 'agent.max_duration',
          },
        ],
      },
    };
    const profileResolved = resolveRemediations(profileBudgetFail);
    expect(profileResolved).toHaveLength(1);
    expect(profileResolved[0]?.action).toEqual({
      kind: 'navigate',
      route: 'settings/preferences',
      params: { focus: 'agent.max_tokens' },
    });

    const envResolved = resolveRemediations(envBudgetFail);
    expect(envResolved).toHaveLength(1);
    expect(envResolved[0]?.action.kind).toBe('text');
  });
});
