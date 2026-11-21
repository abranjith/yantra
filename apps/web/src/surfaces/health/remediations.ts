import type { DoctorCheck, DoctorCheckId, DoctorStatus } from '@yantra/protocol';

/** App route IDs targeted by Health remediation navigations. */
export type RemediationRouteId =
  | 'settings/browser'
  | 'settings/credentials'
  | 'settings/preferences'
  | 'settings/installation'
  | 'settings/models';

export const REMEDIATION_ROUTE_PATHS: Readonly<Record<RemediationRouteId, string>> = {
  'settings/browser': '/settings/browser',
  'settings/credentials': '/settings/credentials',
  'settings/preferences': '/settings/preferences',
  'settings/installation': '/settings/installation',
  'settings/models': '/settings/models',
};

export type RemediationAction =
  | {
      readonly kind: 'invoke';
      readonly path: readonly string[];
      readonly argv: readonly string[];
    }
  | {
      readonly kind: 'navigate';
      readonly route: RemediationRouteId;
      readonly params: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'text';
      readonly note?: string;
    };

export interface RemediationWhen {
  readonly status: readonly DoctorStatus[];
  readonly matches?: (check: DoctorCheck) => boolean;
  readonly description: string;
}

export interface RemediationEntry {
  readonly id: string;
  readonly check: DoctorCheckId;
  readonly when: RemediationWhen;
  readonly action: RemediationAction;
  readonly resolveAction?: (check: DoctorCheck) => RemediationAction;
  readonly label: string;
  readonly evidence: string;
}

export interface ResolvedRemediation {
  readonly id: string;
  readonly label: string;
  readonly action: RemediationAction;
}

interface InvalidBudgetDetail {
  readonly source?: unknown;
  readonly preferenceKey?: unknown;
}

function invalidBudgetsFrom(check: DoctorCheck): readonly InvalidBudgetDetail[] {
  const raw = check.details?.invalid;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is InvalidBudgetDetail => typeof item === 'object' && item !== null,
  );
}

function firstNonEnvPreferenceKey(check: DoctorCheck): string | null {
  for (const item of invalidBudgetsFrom(check)) {
    if (
      item.source !== 'env' &&
      typeof item.preferenceKey === 'string' &&
      item.preferenceKey.length > 0
    ) {
      return item.preferenceKey;
    }
  }
  return null;
}

function hasEnvInvalidBudget(check: DoctorCheck): boolean {
  return invalidBudgetsFrom(check).some((item) => item.source === 'env');
}

/**
 * Engineered remediation catalog for Health (`SD-4`, FEAT-071 TASK-007).
 *
 * Every entry maps a `DoctorCheckId`, status, and optional detail predicate
 * to either a registry command invocation, an app route navigation, or
 * prose-only (`text`), with `evidence` naming the verified source path.
 */
export const REMEDIATION_CATALOG: readonly RemediationEntry[] = [
  {
    id: 'browser.compatibility.check',
    check: 'browser.compatibility',
    when: {
      status: ['warn', 'fail'],
      matches: (check) =>
        check.details?.compatibility === 'unverified' || check.details?.compatibility === 'stale',
      description: 'status in warn|fail and details.compatibility in unverified|stale',
    },
    action: {
      kind: 'invoke',
      path: ['browser', 'check'],
      argv: [],
    },
    label: 'Run browser check',
    evidence:
      'packages/core/src/browser/doctor.ts checkBrowserCompatibility fixHint ("Run `yantra browser check`"); packages/protocol/src/commands/entries/browser.ts browserCheck (execution: run).',
  },
  {
    id: 'browser.managed.install',
    check: 'browser.managed',
    when: {
      status: ['ok', 'warn', 'fail'],
      matches: (check) => check.details?.status === 'absent' || check.details?.status === 'invalid',
      description: 'details.status in absent|invalid (no ready managed build)',
    },
    action: {
      kind: 'navigate',
      route: 'settings/browser',
      params: { intent: 'install' },
    },
    label: 'Install managed browser',
    evidence:
      'packages/core/src/browser/doctor.ts checkManagedBrowser: absent/invalid managed build points to `yantra browser install`; navigates to Settings -> Browser with intent=install so the user completes the consent form.',
  },
  {
    id: 'search.tavily.api-key.add',
    check: 'search.tavily.api-key',
    when: {
      status: ['warn'],
      description: 'status is warn (Tavily API key absent)',
    },
    action: {
      kind: 'navigate',
      route: 'settings/credentials',
      params: { key: 'tavily.api_key' },
    },
    label: 'Add Tavily key',
    evidence:
      'apps/cli/src/commands/doctor.ts runConfigurationChecks + packages/core/src/extraction/search/config.ts resolveSearchCredential: reads keychain account tavily.api_key.',
  },
  {
    id: 'search.brave.api-key.add',
    check: 'search.brave.api-key',
    when: {
      status: ['warn'],
      description: 'status is warn (Brave API key absent)',
    },
    action: {
      kind: 'navigate',
      route: 'settings/credentials',
      params: { key: 'brave.api_key' },
    },
    label: 'Add Brave key',
    evidence:
      'apps/cli/src/commands/doctor.ts runConfigurationChecks + packages/core/src/extraction/search/config.ts resolveSearchCredential: reads keychain account brave.api_key.',
  },
  {
    id: 'search.provider.scrape.tavily',
    check: 'search.provider',
    when: {
      status: ['warn'],
      matches: (check) => check.details?.kind === 'scrape',
      description: 'status is warn and details.kind is scrape',
    },
    action: {
      kind: 'navigate',
      route: 'settings/credentials',
      params: { key: 'tavily.api_key' },
    },
    label: 'Add Tavily key',
    evidence:
      'apps/cli/src/commands/doctor.ts searchProviderCheck SCRAPED_SEARCH_FIX_HINT: configuring tavily.api_key switches auto-selected search to keyed Tavily API.',
  },
  {
    id: 'search.provider.scrape.brave',
    check: 'search.provider',
    when: {
      status: ['warn'],
      matches: (check) => check.details?.kind === 'scrape',
      description: 'status is warn and details.kind is scrape',
    },
    action: {
      kind: 'navigate',
      route: 'settings/credentials',
      params: { key: 'brave.api_key' },
    },
    label: 'Add Brave key',
    evidence:
      'apps/cli/src/commands/doctor.ts searchProviderCheck SCRAPED_SEARCH_FIX_HINT: configuring brave.api_key switches auto-selected search to keyed Brave API.',
  },
  {
    id: 'agent.budgets.preferences',
    check: 'agent.budgets',
    when: {
      status: ['fail'],
      matches: (check) => firstNonEnvPreferenceKey(check) !== null,
      description: 'status is fail and details.invalid has a non-env entry',
    },
    action: {
      kind: 'navigate',
      route: 'settings/preferences',
      params: { focus: 'agent.max_duration' },
    },
    resolveAction: (check) => ({
      kind: 'navigate',
      route: 'settings/preferences',
      params: { focus: firstNonEnvPreferenceKey(check) ?? 'agent.max_duration' },
    }),
    label: 'Edit preference',
    evidence:
      'packages/agent/src/runtime/diagnostics.ts invalidBudgetSettings: non-env invalid budgets come from profile.yaml preferences and can be updated on Settings -> Preferences.',
  },
  {
    id: 'agent.budgets.env',
    check: 'agent.budgets',
    when: {
      status: ['fail'],
      matches: hasEnvInvalidBudget,
      description: 'status is fail and details.invalid has an env entry',
    },
    action: {
      kind: 'text',
      note: 'This budget comes from the environment the app host started with. Update the environment variable, close every Yantra window, wait for the host to exit, then run yantra ui.',
    },
    label: 'Host environment restart required',
    evidence:
      'packages/agent/src/runtime/diagnostics.ts invalidBudgetSettings: source === "env" comes from the process environment captured at host start (plan_ui D13); no in-app mutation can override it.',
  },
  {
    id: 'config.valid.raw-edit',
    check: 'config.valid',
    when: {
      status: ['fail'],
      description: 'status is fail (config.yaml failed schema validation)',
    },
    action: {
      kind: 'navigate',
      route: 'settings/installation',
      params: { mode: 'raw' },
    },
    label: 'Edit config.yaml',
    evidence:
      'apps/cli/src/commands/doctor.ts runConfigurationChecks + apps/web/src/adapters/ConfigEditAdapter.tsx: Settings -> Installation raw editor validates and saves config.yaml via config edit.',
  },
  {
    id: 'agent.credentials.text',
    check: 'agent.credentials',
    when: {
      status: ['warn'],
      description: 'status is warn (no agent credential available)',
    },
    action: {
      kind: 'text',
    },
    label: 'Manual credential setup',
    evidence:
      'DEVIATION verified against packages/agent/src/adapters/pi/environment.ts (probePiCredential, createPiEnvironment) and apps/cli/src/commands/model.ts: Settings -> Models writes ${secret:...} to config.yaml/models.json, but createPiEnvironment only resolves keychain secrets for --auth-secret (runtime-key), not models.json refs.',
  },
  {
    id: 'keychain.reachable.text',
    check: 'keychain.reachable',
    when: {
      status: ['warn', 'fail'],
      description: 'status in warn|fail (OS keychain unavailable)',
    },
    action: { kind: 'text' },
    label: 'OS keychain remediation',
    evidence:
      'packages/core/src/browser/doctor.ts: OS-level keychain condition with no engineered in-app fix.',
  },
  {
    id: 'datadir.writable.text',
    check: 'datadir.writable',
    when: {
      status: ['warn', 'fail'],
      description: 'status in warn|fail (data directory not writable)',
    },
    action: { kind: 'text' },
    label: 'Filesystem permissions',
    evidence:
      'packages/core/src/browser/doctor.ts: OS-level directory writability with no engineered in-app fix.',
  },
  {
    id: 'datadir.permissions.text',
    check: 'datadir.permissions',
    when: {
      status: ['warn', 'fail'],
      description: 'status in warn|fail (data directory permissions)',
    },
    action: { kind: 'text' },
    label: 'Filesystem permissions',
    evidence:
      'packages/core/src/browser/doctor.ts: OS-level directory permissions with no engineered in-app fix.',
  },
  {
    id: 'cachedir.writable.text',
    check: 'cachedir.writable',
    when: {
      status: ['warn', 'fail'],
      description: 'status in warn|fail (cache directory not writable)',
    },
    action: { kind: 'text' },
    label: 'Filesystem permissions',
    evidence:
      'packages/core/src/browser/doctor.ts: OS-level cache directory writability with no engineered in-app fix.',
  },
  {
    id: 'indexdb.writable.text',
    check: 'indexdb.writable',
    when: {
      status: ['warn', 'fail'],
      description: 'status in warn|fail (SQLite index not writable)',
    },
    action: { kind: 'text' },
    label: 'SQLite index permissions',
    evidence:
      'packages/core/src/browser/doctor.ts: OS-level SQLite index writability with no engineered in-app fix.',
  },
  {
    id: 'paths.resolved.info',
    check: 'paths.resolved',
    when: {
      status: ['ok', 'warn', 'fail'],
      description: 'informational resolved storage paths',
    },
    action: { kind: 'text' },
    label: 'Informational',
    evidence:
      'apps/cli/src/commands/doctor.ts runConfigurationChecks: informational storage path resolution.',
  },
  {
    id: 'ethics.robots.info',
    check: 'ethics.robots',
    when: {
      status: ['ok', 'warn', 'fail'],
      description: 'informational robots policy status',
    },
    action: { kind: 'text' },
    label: 'Informational',
    evidence:
      'apps/cli/src/commands/doctor.ts runConfigurationChecks: informational robots policy state.',
  },
  {
    id: 'agent.model.info',
    check: 'agent.model',
    when: {
      status: ['ok', 'warn', 'fail'],
      description: 'informational resolved model/provider summary',
    },
    action: { kind: 'text' },
    label: 'Informational',
    evidence:
      'packages/agent/src/runtime/diagnostics.ts: informational resolved agent model/provider.',
  },
  {
    id: 'browser.selection.info',
    check: 'browser.selection',
    when: {
      status: ['ok', 'warn', 'fail'],
      description: 'informational browser selection status',
    },
    action: { kind: 'text' },
    label: 'Informational',
    evidence:
      'packages/core/src/browser/doctor.ts: reports resolved browser selection or OS-level absence.',
  },
];

/** Returns all matching remediations for a single doctor check. */
export function resolveRemediations(check: DoctorCheck): readonly ResolvedRemediation[] {
  const results: ResolvedRemediation[] = [];
  for (const entry of REMEDIATION_CATALOG) {
    if (entry.check !== check.id) continue;
    if (!entry.when.status.includes(check.status)) continue;
    if (entry.when.matches !== undefined && !entry.when.matches(check)) continue;
    results.push({
      id: entry.id,
      label: entry.label,
      action: entry.resolveAction ? entry.resolveAction(check) : entry.action,
    });
  }
  return results;
}
