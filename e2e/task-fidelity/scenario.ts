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
  readonly deliverable: 'table' | 'answer' | 'report';
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
  /** The deterministic tier's script. */
  readonly script: readonly ScriptStep[];
  /** The deterministic tier's expectations. */
  readonly expectations: readonly Expectation[];
  readonly tiers: readonly Tier[];
  /** The ground truth a faithful answer is scored against. */
  readonly truth: () => readonly ScenarioTruthRow[];
}
