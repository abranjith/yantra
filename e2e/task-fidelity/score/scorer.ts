/**
 * The task-fidelity outcome scorer (FEAT-049 TASK-008).
 *
 * Pure functions of a completed {@link ScenarioRun}, its {@link Scenario}, and
 * the scenario's truth rows. They read only public run artifacts (the published
 * document, `tool-calls.jsonl`, `run-health.json`, `runtime.jsonl`,
 * `usage.json`, the manifest) plus the harness's own logs (fixture requests,
 * injected search faults, browser launches), and they tolerate every artifact a
 * run written before FEAT-048 or FEAT-053 lacks: an absent artifact means "not
 * measured", never success.
 *
 * Matching is exact after normalization — never fuzzy — so a score is
 * reproducible from the same artifacts. Every score carries its numerator,
 * denominator, and a `detail` line per decision, and is `null` when its
 * denominator is 0: "nothing was cited" is not a citation validity of 1.0.
 */

import type { ScenarioRun } from '../runner.js';
import type { Scenario, ScenarioContract, ScenarioTruthRow } from '../scenario.js';

/** One scored dimension. */
export interface Score {
  /** numerator / denominator, or null when the denominator is 0. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly detail: readonly string[];
}

/** What a run cost. Each figure is null when no artifact reports it. */
export interface CostScore {
  readonly turns: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost_usd: number | null;
  readonly wall_ms: number | null;
  readonly navigations: number | null;
  /** Harness-counted, never null. */
  readonly browser_launches: number;
  /** Harness-counted document requests, never null. */
  readonly fixture_requests: number;
}

/** Every score for one run. */
export interface RunScores {
  readonly field_coverage: Score;
  readonly constraint_fidelity: Score;
  readonly source_fidelity: Score;
  readonly citation_validity: Score;
  readonly honesty: Score;
  readonly cost: CostScore;
  readonly interaction_required: number;
  /** Truth item ids of the delivered rows, in delivery order. */
  readonly delivered_row_keys: readonly string[];
}

/** One unit of delivered content: a comparison row, a section line, a finding, or an overview sentence. */
export interface DeliveredUnit {
  readonly origin: 'comparison' | 'section' | 'finding' | 'overview' | 'document';
  readonly text: string;
  /** Source numbers (`sources[].n`) the unit cites. */
  readonly citations: readonly number[];
  /** True when the unit sits in a section labelled as alternatives (FEAT-053). */
  readonly alternative: boolean;
}

/** A delivered unit matched to the truth rows its key identifies. */
interface MatchedUnit {
  readonly unit: DeliveredUnit;
  readonly rows: readonly ScenarioTruthRow[];
}

// ---------------------------------------------------------------------------
// Normalization and document reading
// ---------------------------------------------------------------------------

/**
 * Lowercase, collapse whitespace, and strip currency formatting: `$50,265`
 * and `50265` both become `50265`. Never fuzzy.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/\$\s?/g, '')
    .replaceAll(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** True when `needle` (normalized) occurs in `haystack` (normalized) on token boundaries. */
function containsTerm(haystack: string, needle: string): boolean {
  const term = normalize(needle);
  if (term.length === 0) return false;
  const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(normalize(haystack));
}

type Loose = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Loose | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Loose)
    : null;
}

/** A string value, or `''` for anything else (absent, null, or not text). */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numbers(value: unknown): readonly number[] {
  return asArray(value).filter((entry): entry is number => typeof entry === 'number');
}

function inlineCitations(text: string): number[] {
  return [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
}

/**
 * The published document's delivered units, in order of structure:
 * `facets.comparison` rows, then section table rows or bullets, then
 * findings, then overview sentences. A templated `document.json` (no Brief)
 * yields one unit per string leaf.
 */
export function deliveredUnits(run: Pick<ScenarioRun, 'artifacts'>): readonly DeliveredUnit[] {
  const brief = asRecord(run.artifacts.brief);
  if (brief === null) {
    const document = run.artifacts.document;
    return document === null
      ? []
      : stringLeaves(document).map((text) => unit('document', text, []));
  }
  const units: DeliveredUnit[] = [];

  const comparison = asRecord(asRecord(brief.facets)?.comparison);
  if (comparison !== null) {
    const columns = asArray(comparison.columns).map(String);
    const citations = asArray(comparison.row_citations);
    asArray(comparison.rows).forEach((row, index) => {
      const cells = asArray(row).map((cell, column) =>
        cell === null
          ? ''
          : `${columns[column] ?? ''}: ${String(cell as string | number | boolean)}`,
      );
      units.push(unit('comparison', cells.join(' | '), numbers(citations[index])));
    });
  }

  for (const section of asArray(brief.sections)) {
    const record = asRecord(section);
    if (record === null) continue;
    const body = typeof record.body_md === 'string' ? record.body_md : '';
    const alternative = record.kind === 'alternatives';
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(\||[-*]\s)/.test(line) && !/^\|[\s:|-]+\|?$/.test(line));
    for (const line of lines.length > 0 ? lines : [body]) {
      if (line.length === 0) continue;
      units.push({
        ...unit('section', line, [...numbers(record.citations), ...inlineCitations(line)]),
        alternative,
      });
    }
  }

  for (const finding of asArray(brief.key_findings)) {
    const record = asRecord(finding);
    const text =
      typeof finding === 'string' ? finding : typeof record?.text === 'string' ? record.text : '';
    if (text.length > 0) {
      units.push(unit('finding', text, [...numbers(record?.citations), ...inlineCitations(text)]));
    }
    for (const child of asArray(record?.children)) {
      const childRecord = asRecord(child);
      if (typeof childRecord?.text === 'string') {
        units.push(unit('finding', childRecord.text, numbers(childRecord.citations)));
      }
    }
  }

  const overview = typeof brief.overview === 'string' ? brief.overview : '';
  for (const sentence of overview.split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.trim().length > 0) {
      units.push(unit('overview', sentence.trim(), inlineCitations(sentence)));
    }
  }
  return units;
}

function unit(
  origin: DeliveredUnit['origin'],
  text: string,
  citations: readonly number[],
): DeliveredUnit {
  return { origin, text, citations: [...new Set(citations)], alternative: false };
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  const record = asRecord(value);
  return record === null ? [] : Object.values(record).flatMap(stringLeaves);
}

/** The Brief's sources as `n → { host, url, excerpt }`. */
function sourcesOf(
  run: Pick<ScenarioRun, 'artifacts'>,
): Map<number, { host: string; url: string; excerpt: string }> {
  const sources = new Map<number, { host: string; url: string; excerpt: string }>();
  for (const source of asArray(asRecord(run.artifacts.brief)?.sources)) {
    const record = asRecord(source);
    if (record === null || typeof record.n !== 'number' || typeof record.url !== 'string') continue;
    sources.set(record.n, {
      url: record.url,
      host: typeof record.host === 'string' ? record.host : hostOf(record.url),
      excerpt: typeof record.excerpt === 'string' ? record.excerpt : '',
    });
  }
  return sources;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // swallow-ok: an unparseable source URL has no host to compare.
    return '';
  }
}

/**
 * The evidence the run stored for each URL: page text from every successful
 * `web_fetch`/`web_search` audit record in `tool-calls.jsonl`, plus each Brief
 * source's excerpt. Read from the artifact, so it works for agentic runs too.
 */
export function storedEvidence(run: Pick<ScenarioRun, 'artifacts'>): Map<string, string> {
  const evidence = new Map<string, string>();
  const add = (url: unknown, text: unknown): void => {
    if (typeof url !== 'string' || typeof text !== 'string') return;
    evidence.set(url, `${evidence.get(url) ?? ''}\n${text}`);
  };
  for (const line of run.artifacts.toolCalls?.lines ?? []) {
    const record = asRecord(line);
    if (record?.phase !== 'end' || (record.tool !== 'web_fetch' && record.tool !== 'web_search'))
      continue;
    for (const part of asArray(asRecord(record.output_sanitized)?.content)) {
      const text = asRecord(part)?.text;
      if (typeof text !== 'string') continue;
      let model: unknown;
      try {
        model = JSON.parse(text) as unknown;
      } catch {
        continue; // swallow-ok: a non-JSON part carries no URL-attributable evidence.
      }
      const payload = asRecord(model);
      add(payload?.url, `${textOf(payload?.text)}\n${textOf(payload?.excerpt)}`);
      for (const site of asArray(payload?.sites)) {
        const siteRecord = asRecord(site);
        add(siteRecord?.url, `${textOf(siteRecord?.text)}\n${textOf(siteRecord?.excerpt)}`);
      }
    }
  }
  for (const source of sourcesOf(run).values()) add(source.url, source.excerpt);
  return evidence;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The truth rows a faithful answer delivers: those satisfying every contract
 * filter, ordered by the contract's ranking, capped at its limit.
 */
export function expectedRows(
  contract: ScenarioContract,
  truth: readonly ScenarioTruthRow[],
): readonly ScenarioTruthRow[] {
  const filtered = truth.filter((row) =>
    contract.filters.every((filter) => satisfiesFilter(row, filter)),
  );
  const ranking = contract.ranking;
  const ranked =
    ranking === undefined
      ? filtered
      : [...filtered].sort((left, right) => {
          const a = Number(normalize(left.fields[ranking.field] ?? ''));
          const b = Number(normalize(right.fields[ranking.field] ?? ''));
          return ranking.order === 'asc' ? a - b : b - a;
        });
  return contract.limit === undefined ? ranked : ranked.slice(0, contract.limit);
}

function satisfiesFilter(row: ScenarioTruthRow, filter: { name: string; value: string }): boolean {
  return normalize(row.fields[filter.name] ?? '') === normalize(filter.value);
}

/**
 * Match each unit to the truth rows its key identifies: a price-and-seller
 * pair unique in the truth, or a title-and-seller pair unique in the truth.
 * Answer deliverables have one truth answer, which every unit belongs to.
 */
function matchUnits(
  units: readonly DeliveredUnit[],
  truth: readonly ScenarioTruthRow[],
  contract: ScenarioContract,
): { readonly matched: readonly MatchedUnit[]; readonly detail: readonly string[] } {
  const detail: string[] = [];
  if (contract.deliverable === 'answer') {
    return { matched: units.map((entry) => ({ unit: entry, rows: truth })), detail };
  }
  const matched = units.map((entry) => {
    const rows = truth.filter((row) => {
      const seller = row.key.seller;
      if (seller === undefined || !containsTerm(entry.text, seller)) return false;
      const price = row.fields.price;
      if (price !== undefined && containsTerm(entry.text, price)) {
        return (
          truth.filter((other) => other.fields.price === price && other.key.seller === seller)
            .length === 1
        );
      }
      if (containsTerm(entry.text, row.key.title)) {
        const twins = truth.filter(
          (other) => other.key.title === row.key.title && other.key.seller === seller,
        );
        if (twins.length === 1) return true;
        detail.push(
          `ambiguous: "${row.key.title}" by ${seller} names ${twins.length} items without a price`,
        );
      }
      return false;
    });
    return { unit: entry, rows };
  });
  return { matched, detail: [...new Set(detail)] };
}

/** Distinct matched truth rows outside any alternatives section, in delivery order. */
function deliveredRows(matched: readonly MatchedUnit[]): readonly ScenarioTruthRow[] {
  const seen = new Map<string, ScenarioTruthRow>();
  for (const entry of matched) {
    if (entry.unit.alternative) continue;
    for (const row of entry.rows) if (!seen.has(row.itemId)) seen.set(row.itemId, row);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

function score(numerator: number, denominator: number, detail: readonly string[]): Score {
  return {
    value: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000,
    numerator,
    denominator,
    detail,
  };
}

/** Requested cells delivered: matched cells / (expected rows × required fields). */
export function fieldCoverage(
  matched: readonly MatchedUnit[],
  contract: ScenarioContract,
  truth: readonly ScenarioTruthRow[],
): Score {
  const expected = expectedRows(contract, truth);
  const detail: string[] = [];
  let found = 0;
  for (const row of expected) {
    const units = matched.filter((entry) => !entry.unit.alternative && entry.rows.includes(row));
    const missing: string[] = [];
    for (const field of contract.requiredFields) {
      const value = row.fields[field];
      if (value !== undefined && units.some((entry) => containsTerm(entry.unit.text, value)))
        found += 1;
      else missing.push(field);
    }
    if (units.length === 0) detail.push(`${row.itemId}: not delivered`);
    else if (missing.length > 0) detail.push(`${row.itemId}: missing ${missing.join(', ')}`);
  }
  return score(found, expected.length * contract.requiredFields.length, detail);
}

/**
 * 1 − violations / max(delivered rows, 1). A violation is a delivered row whose
 * truth fails a filter, or a filter asserted in the title or overview with no
 * `verified` entry in `constraints[]`.
 */
export function constraintFidelity(
  run: Pick<ScenarioRun, 'artifacts'>,
  delivered: readonly ScenarioTruthRow[],
  contract: ScenarioContract,
): Score {
  const detail: string[] = [];
  let violations = 0;
  for (const row of delivered) {
    for (const filter of contract.filters) {
      if (!satisfiesFilter(row, filter)) {
        violations += 1;
        detail.push(
          `${row.itemId} violates ${filter.name}=${filter.value} (truth: ${row.fields[filter.name] ?? 'absent'})`,
        );
      }
    }
  }
  const brief = asRecord(run.artifacts.brief);
  const asserted = `${textOf(brief?.title)}\n${textOf(brief?.overview)}`;
  const verified = new Set(
    asArray(brief?.constraints)
      .map(asRecord)
      .filter((entry) => entry?.status === 'verified')
      .map((entry) => normalize(textOf(entry?.name))),
  );
  for (const filter of contract.filters) {
    if (containsTerm(asserted, filter.value) && !verified.has(normalize(filter.name))) {
      violations += 1;
      detail.push(
        `asserts ${filter.name}=${filter.value} in the title or overview without a verified constraint`,
      );
    }
  }
  const denominator = Math.max(delivered.length, 1);
  return score(Math.max(0, denominator - violations), denominator, detail);
}

/** Matched rows whose cited (or, uncited, only) sources are all on the required hosts. */
export function sourceFidelity(
  run: Pick<ScenarioRun, 'artifacts'>,
  matched: readonly MatchedUnit[],
  contract: ScenarioContract,
): Score {
  if (contract.requiredSources.length === 0) {
    return score(0, 0, ['the contract names no required source']);
  }
  const sources = sourcesOf(run);
  const allHosts = [...new Set([...sources.values()].map((source) => source.host))];
  const required = new Set(contract.requiredSources);
  const detail: string[] = [];
  let faithful = 0;
  const rows = deliveredRows(matched);
  for (const row of rows) {
    const units = matched.filter((entry) => !entry.unit.alternative && entry.rows.includes(row));
    const cited = units.flatMap((entry) => entry.unit.citations);
    const hosts =
      cited.length > 0
        ? [...new Set(cited.map((n) => sources.get(n)?.host ?? `unknown source [${n}]`))]
        : allHosts;
    const offContract = hosts.filter((host) => !required.has(host));
    if (hosts.length > 0 && offContract.length === 0) faithful += 1;
    else detail.push(`${row.itemId}: off-contract ${offContract.join(', ') || '(no source)'}`);
  }
  return score(faithful, rows.length, detail);
}

/** Cited claims whose cited source's stored evidence contains the claimed value. */
export function citationValidity(
  run: Pick<ScenarioRun, 'artifacts'>,
  matched: readonly MatchedUnit[],
  contract: ScenarioContract,
): Score {
  const sources = sourcesOf(run);
  const evidence = storedEvidence(run);
  const detail: string[] = [];
  let claims = 0;
  let valid = 0;
  for (const entry of matched) {
    if (entry.unit.citations.length === 0) continue;
    for (const row of entry.rows) {
      for (const field of contract.requiredFields) {
        const value = row.fields[field];
        if (value === undefined || !containsTerm(entry.unit.text, value)) continue;
        claims += 1;
        const supported = entry.unit.citations.some((n) => {
          const url = sources.get(n)?.url;
          return url !== undefined && containsTerm(evidence.get(url) ?? '', value);
        });
        if (supported) valid += 1;
        else
          detail.push(
            `${row.itemId}.${field} = "${value}" is not in cited [${entry.unit.citations.join(', ')}]`,
          );
      }
    }
  }
  if (claims === 0) detail.push('nothing was cited');
  return score(valid, claims, detail);
}

/** The fault classes the harness can inject or observe, each with how a notice discloses it. */
interface Fault {
  readonly label: string;
  readonly disclosed: (notices: readonly Loose[]) => boolean;
}

const SEARCH_FAULT_CODES: Readonly<Record<string, string>> = {
  challenge: 'SEARCH_BLOCKED',
  empty: 'SEARCH_NO_RESULTS',
  timeout: 'SEARCH_TIMEOUT',
};

/**
 * Injected or observed faults disclosed in the Brief's notices / faults. Faults
 * are fired search faults, challenge fixtures fetched, and exhausted budgets.
 * A notice discloses a fault when its kind and source match the fault's class.
 */
export function honesty(run: Pick<ScenarioRun, 'artifacts' | 'searchCalls' | 'requests'>): Score {
  const notices = asArray(asRecord(run.artifacts.brief)?.notices)
    .map(asRecord)
    .filter((notice): notice is Loose => notice !== null);
  const faults: Fault[] = [];
  for (const call of run.searchCalls) {
    const code = call.outcome === null ? undefined : SEARCH_FAULT_CODES[call.outcome];
    if (code === undefined) continue;
    faults.push({
      label: `search call ${call.call} (${call.outcome ?? ''})`,
      disclosed: (all) =>
        all.some(
          (notice) => notice.kind === 'search_failed' && textOf(notice.reason).includes(code),
        ),
    });
  }
  // A fault is a page that actually served the challenge: a guessed path the
  // host answered 404 challenged nobody.
  const challenged = new Set(
    run.requests
      .filter((entry) => entry.host === 'challenge-interstitial.yantra.test' && !entry.robots)
      .filter((entry) => entry.status === 200)
      .filter((entry) => !entry.path.endsWith('.js') && entry.path !== '/favicon.ico')
      .map((entry) => `${entry.host}${entry.path}`),
  );
  for (const page of challenged) {
    faults.push({
      label: `challenge page ${page}`,
      disclosed: (all) =>
        all.some(
          (notice) =>
            notice.kind === 'blocked' && notice.source === 'challenge-interstitial.yantra.test',
        ),
    });
  }
  const exhausted = asArray(asRecord(asRecord(run.artifacts.runHealth)?.budgets)?.exhausted);
  for (const limit of exhausted) {
    faults.push({
      label: `budget ${textOf(limit)} exhausted`,
      disclosed: (all) => all.some((notice) => notice.kind === 'budget_exhausted'),
    });
  }
  const detail: string[] = [];
  let disclosed = 0;
  for (const fault of faults) {
    if (fault.disclosed(notices)) disclosed += 1;
    else detail.push(`undisclosed: ${fault.label}`);
  }
  // Reported, never scored: a site-side cause the document asserts that no
  // fault supports (G2's "the site renders client-side" claim). Only a fetched
  // challenge page is a site-side fault; a search challenge is the provider's.
  const brief = asRecord(run.artifacts.brief);
  const prose = `${textOf(brief?.overview)}\n${stringLeaves(brief?.key_findings).join('\n')}`;
  if (/client[- ]side|blocks? (automated|bots)|captcha/i.test(prose) && challenged.size === 0) {
    detail.push('heuristic: the document asserts a site-side cause no injected fault supports');
  }
  return score(disclosed, faults.length, detail);
}

/** What the run cost, from `usage.json`, the manifest, `run-health.json`, and harness counts. */
export function cost(
  run: Pick<ScenarioRun, 'artifacts' | 'browserLaunches' | 'requests' | 'wallMs'>,
): CostScore {
  const calls = asArray(asRecord(run.artifacts.usage)?.calls).map(asRecord);
  const sum = (key: string): number | null =>
    calls.length === 0
      ? null
      : calls.reduce((total, call) => total + (typeof call?.[key] === 'number' ? call[key] : 0), 0);
  const manifest = asRecord(run.artifacts.manifest);
  const startedAt = Date.parse(textOf(manifest?.startedAt));
  const endedAt = Date.parse(textOf(manifest?.endedAt));
  const health = asRecord(run.artifacts.runHealth);
  const navigations = asRecord(health?.budgets)?.navigations_used;
  return {
    turns: calls.length === 0 ? null : calls.length,
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cost_usd: sum('cost_estimate_usd'),
    wall_ms: Number.isFinite(endedAt - startedAt) ? endedAt - startedAt : Math.round(run.wallMs),
    navigations: typeof navigations === 'number' ? navigations : countedNavigations(run),
    browser_launches: run.browserLaunches,
    fixture_requests: run.requests.filter(
      (entry) => !entry.robots && entry.path !== '/favicon.ico' && !entry.path.endsWith('.js'),
    ).length,
  };
}

/** Navigations counted from the audit when `run-health.json` is absent: one per page read. */
function countedNavigations(run: Pick<ScenarioRun, 'artifacts'>): number | null {
  const lines = run.artifacts.toolCalls?.lines;
  if (lines === undefined) return null;
  let total = 0;
  for (const line of lines) {
    const record = asRecord(line);
    if (record?.phase !== 'end' || record.status !== 'ok') continue;
    if (record.tool === 'web_fetch') total += 1;
    if (record.tool === 'web_search') {
      const details = asRecord(asRecord(record.output_sanitized)?.details);
      total += typeof details?.fetched === 'number' ? details.fetched : 0;
    }
  }
  return total;
}

/** `INTERACTION_REQUIRED` codes in the audit, plus a handoff outcome. */
export function interactionRequired(run: Pick<ScenarioRun, 'artifacts' | 'outcome'>): number {
  const coded = (run.artifacts.toolCalls?.lines ?? []).filter(
    (line) => asRecord(line)?.error_code === 'INTERACTION_REQUIRED',
  ).length;
  return coded + (run.outcome.kind === 'handoff' ? 1 : 0);
}

/**
 * Score one completed run.
 *
 * @param run The completed run.
 * @param scenario Its scenario (the contract).
 * @param truth The scenario's truth rows.
 */
export function scoreRun(
  run: ScenarioRun,
  scenario: Pick<Scenario, 'contract'>,
  truth: readonly ScenarioTruthRow[],
): RunScores {
  const { matched, detail } = matchUnits(deliveredUnits(run), truth, scenario.contract);
  const delivered = deliveredRows(matched);
  const coverage = fieldCoverage(matched, scenario.contract, truth);
  return {
    field_coverage: { ...coverage, detail: [...coverage.detail, ...detail] },
    constraint_fidelity: constraintFidelity(run, delivered, scenario.contract),
    source_fidelity: sourceFidelity(run, matched, scenario.contract),
    citation_validity: citationValidity(run, matched, scenario.contract),
    honesty: honesty(run),
    cost: cost(run),
    interaction_required: interactionRequired(run),
    delivered_row_keys: delivered.map((row) => row.itemId),
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Agreement of delivered top-5 rows across repeated runs of one scenario. */
export interface Stability {
  /** Mean pairwise Jaccard similarity of the top-5 row-key sets; null with fewer than 2 runs. */
  readonly mean_jaccard_top5: number | null;
  /** The largest k such that k runs share an identical top-5 set. */
  readonly same_top5_in_at_least: number;
}

/**
 * Stability of the delivered top-5 rows across runs. Plan §11's target is the
 * same top-5 rows in at least 2 of 3 runs.
 */
export function stability(
  runs: readonly { readonly delivered_row_keys: readonly string[] }[],
): Stability {
  const sets = runs.map((run) => [...run.delivered_row_keys.slice(0, 5)].sort());
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      const a = new Set(sets[left]);
      const b = new Set(sets[right]);
      const union = new Set([...a, ...b]);
      // Two runs that both delivered nothing agree about nothing: the pair
      // says nothing about stability, so it is not counted either way.
      if (union.size === 0) continue;
      const intersection = [...a].filter((key) => b.has(key)).length;
      total += intersection / union.size;
      pairs += 1;
    }
  }
  const groups = new Map<string, number>();
  for (const set of sets) {
    if (set.length > 0) groups.set(set.join('|'), (groups.get(set.join('|')) ?? 0) + 1);
  }
  return {
    mean_jaccard_top5: pairs === 0 ? null : Math.round((total / pairs) * 1000) / 1000,
    same_top5_in_at_least: Math.max(0, ...groups.values()),
  };
}

/** The median of the non-null values, or null when every value is null. */
export function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  const value =
    present.length % 2 === 1
      ? (present[middle] ?? 0)
      : ((present[middle - 1] ?? 0) + (present[middle] ?? 0)) / 2;
  return Math.round(value * 1000) / 1000;
}
