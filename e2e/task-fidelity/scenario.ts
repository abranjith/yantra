/**
 * The `Scenario` shape shared by the runner, the deterministic tier, the
 * scorer, and the agentic runner (FEAT-049).
 */

import type { AgentBudgetConfig, AgenticCommand } from '@yantra/agent';
import type { SearchProviderName } from '@yantra/core';

import type { ScriptStep } from './agent/scripted-provider.js';
import type { Expectation } from './expectations.js';
import type { SiteName } from './fixtures/sites.js';
import type { ScriptedSerpEntry, SearchFault } from './search/scripted-provider.js';

/** A tier a scenario runs in. */
export type Tier = 'deterministic' | 'agentic';

/** Independent, authored correctness rules for fixture controls. */
export type ValueRule =
  | {
      readonly kind:
        | 'nonempty'
        | 'letters'
        | 'email'
        | 'date'
        | 'choice'
        | 'protected'
        | 'untouched';
    }
  | { readonly kind: 'digits' | 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'checked-any'; readonly group: string };

export interface ActionTruth {
  readonly page: string;
  readonly rules: Readonly<Record<string, ValueRule>>;
  readonly intended?: Readonly<Record<string, string | boolean>>;
  readonly artifacts: readonly ('viewport' | 'full_page' | 'element')[];
  readonly submit: 'forbidden' | 'allowed';
}

/** One filter the user's request imposes, as a truth field name and value. */
export interface ContractFilter {
  readonly name: string;
  readonly value: string;
}

/**
 * The harness's own ground-truth contract for a scenario: what a faithful
 * answer delivers.
 *
 * It is used only for scoring and is never passed to the run — FEAT-052 owns
 * how a run declares a contract, and a harness that handed the run its answer
 * key would measure nothing.
 */
export interface ScenarioContract {
  readonly actionTruth?: ActionTruth;
  readonly deliverable: 'table' | 'answer' | 'report' | 'actions';
  /** Truth fields every delivered row (or the answer) must carry. */
  readonly requiredFields: readonly string[];
  readonly filters: readonly ContractFilter[];
  /** Hostnames the answer must come from. */
  readonly requiredSources: readonly string[];
  readonly ranking?: { readonly field: string; readonly order: 'asc' | 'desc' };
  readonly limit?: number;
}

/** A ground-truth row: the identity a delivered row must carry, and its fields. */
export interface ScenarioTruthRow {
  readonly itemId: string;
  readonly key: { readonly title: string; readonly seller?: string };
  readonly fields: Readonly<Record<string, string>>;
}

/** One task-fidelity scenario. */
export interface Scenario {
  readonly suite?: 'do-benchmark';
  /** Unique across the catalogue. */
  readonly id: string;
  readonly sites: readonly SiteName[];
  readonly command: AgenticCommand;
  /** Fixture-native; names its required source by host. */
  readonly goal: string;
  readonly contract: ScenarioContract;
  /** The location the user granted, or null when the scenario grants none. */
  readonly userLocation: string | null;
  /** The scripted SERP table. */
  readonly serps: readonly ScriptedSerpEntry[];
  readonly faults?: readonly SearchFault[];
  /** The search provider's name; defaults to `duckduckgo`. */
  readonly searchProviderName?: SearchProviderName;
  readonly budgets?: Partial<AgentBudgetConfig>;
  /**
   * Whether a `research` run gets the read-only browser, as the stored
   * `agent.research_browse` preference or `--no-browse` would decide it.
   * Defaults to `true`, the product default (FEAT-052).
   */
  readonly browse?: boolean;
  /**
   * Grants Vision Assist (`context.screenshots`) with an image-capable model,
   * so `browser_screenshot` is registered (FEAT-054). Defaults to false.
   */
  readonly visionAssist?: boolean;
  /**
   * Runs with `--no-screenshots` (FEAT-058): neither capture tool is
   * registered, and a declared screenshot is disclosed as a gap. Defaults to
   * false.
   */
  readonly screenshotsSuppressed?: boolean;
  /**
   * The deterministic tier's allowance for this scenario, when it needs more
   * than the default: real-Chrome form fills cost seconds per field until
   * FEAT-057 lands.
   */
  readonly timeoutMs?: number;
  /** The deterministic tier's script. */
  readonly script: readonly ScriptStep[];
  /** The deterministic tier's expectations. */
  readonly expectations: readonly Expectation[];
  readonly tiers: readonly Tier[];
  /** The ground truth a faithful answer is scored against. */
  readonly truth: () => readonly ScenarioTruthRow[];
}
