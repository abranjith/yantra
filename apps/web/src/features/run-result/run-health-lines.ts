/**
 * The Run Health lines (FEAT-066 TASK-007), worded exactly as the
 * `## Run Health` section of `report.md` (core `MarkdownReportBuilder`).
 *
 * Dependency-free on purpose: browser code may not import core, so this is a
 * port, and a core test imports this module and compares it with the report
 * builder's own output for the same `run-health.json`.
 */

import type { RunHealth } from '@yantra/protocol';

/** `CODE n, CODE n` in descending count, then code order. */
function codeList(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([code, count]) => `${code} ${String(count)}`)
    .join(', ');
}

function extractionLine(extraction: NonNullable<RunHealth['extraction']>): string {
  const shapes = Object.entries(extraction.pages_by_shape)
    .filter(([, count]) => count !== undefined && count > 0)
    .map(([shape, count]) => `${shape} ${String(count ?? 0)}`)
    .join(', ');
  return (
    `Extraction: pages ${shapes.length === 0 ? 'none' : shapes} - records shown ${String(extraction.records_shown)}` +
    ` - links offered ${String(extraction.links_offered)}, withheld ${String(extraction.links_withheld)}, ` +
    `followed ${String(extraction.discovered_follows)}`
  );
}

/** The section's lines, without the `## Run Health` heading. */
export function runHealthLines(health: RunHealth): string[] {
  const failedSearches = Object.values(health.searches.failed_by_code).reduce(
    (sum, count) => sum + count,
    0,
  );
  const providers =
    health.searches.providers.length === 0 ? 'none' : health.searches.providers.join(', ');
  const fetchFailures = codeList(health.fetches.failed_by_code);
  const failures = health.source_failures;
  const exhausted =
    health.budgets.exhausted.length === 0 ? 'none' : health.budgets.exhausted.join(', ');
  return [
    `Searches: ${String(health.searches.total)} total, ${String(health.searches.ok)} ok, ${String(failedSearches)} failed` +
      `${failedSearches === 0 ? '' : ` (${codeList(health.searches.failed_by_code)})`}` +
      ` - providers: ${providers}`,
    `Fetches: ${String(health.fetches.total)} total (${String(health.fetches.by_mode.http)} http, ` +
      `${String(health.fetches.by_mode.browser)} browser), ${String(health.fetches.repeat_fetches)} repeat` +
      `${fetchFailures.length === 0 ? '' : ` - failed: ${fetchFailures}`}`,
    `Source failures: fetch ${String(failures.fetch)}, extract ${String(failures.extract)}, ` +
      `blocked ${String(failures.blocked)}, budget ${String(failures.budget)}, policy ${String(failures.policy)}`,
    `Browser launches: ${String(health.browser.launches)}`,
    `Navigations: ${String(health.budgets.navigations_used)}/${String(health.budgets.navigations_limit)}   ` +
      `Hosts: ${String(health.budgets.hosts_used)}/${String(health.budgets.hosts_limit)}   ` +
      `Exhausted: ${exhausted}`,
    `Tool failures: ${String(health.tool_failures.total)}` +
      `${health.tool_failures.total === 0 ? '' : ` (${codeList(health.tool_failures.by_code)})`}`,
    `Notices: ${String(health.notices)}`,
    ...(health.extraction === undefined ? [] : [extractionLine(health.extraction)]),
  ];
}
