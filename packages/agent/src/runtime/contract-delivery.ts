/** Pure checking of published delivery against the run's declared contract. */
import type { BriefNotice, TaskContractBody } from '@yantra/protocol';

import type { ComposeIssue, PublishCell } from './brief-composer.js';

export const NOT_SHOWN_ON_SOURCE = 'not shown on source';
export interface DeliveryConstraint {
  readonly name: string;
  readonly value: string;
  readonly status: 'verified' | 'unverified' | 'violated';
  readonly refs: string[];
  readonly cause?: string;
}
/** Contract filters lead; omitted or unsupported verification is explicitly unknown. */
export function reconcileConstraints(
  input: readonly DeliveryConstraint[],
  contract: TaskContractBody | null,
  supported: (condition: DeliveryConstraint) => boolean,
): { constraints: DeliveryConstraint[]; notices: BriefNotice[] } {
  const normalized = input.map(
    (condition): DeliveryConstraint =>
      condition.status === 'verified' && condition.refs.length === 0
        ? { ...condition, status: 'unverified', cause: 'marked verified without evidence' }
        : condition,
  );
  const filters = contract?.filters ?? [];
  const names = new Set(filters.map((filter) => normalizeDeliveryName(filter.name)));
  const constraints = [
    ...filters.map((filter): DeliveryConstraint => {
      const condition = normalized.find(
        (entry) => normalizeDeliveryName(entry.name) === normalizeDeliveryName(filter.name),
      );
      if (condition === undefined)
        return { ...filter, status: 'unverified', refs: [], cause: 'not reported by the agent' };
      if (normalizeDeliveryName(condition.value) === normalizeDeliveryName(filter.value))
        return { ...condition, ...filter };
      const confirmed = condition.refs.length > 0 && supported(condition);
      return {
        ...condition,
        ...filter,
        status: confirmed ? 'violated' : 'unverified',
        cause: `${confirmed ? 'source reports' : 'agent reported an unconfirmed'} ${condition.value}`,
      };
    }),
    ...normalized.filter((condition) => !names.has(normalizeDeliveryName(condition.name))),
  ];
  const notices: BriefNotice[] = [];
  for (const status of ['unverified', 'violated'] as const) {
    const items = constraints
      .filter((condition) => condition.status === status)
      .map(
        (condition) =>
          `${condition.name} = ${condition.value}${condition.cause ? ` (${condition.cause})` : ''}`,
      );
    if (items.length > 0)
      notices.push({
        kind: 'contract_gap',
        source: 'task-contract',
        reason: boundedNotice(status === 'unverified' ? 'Not confirmed: ' : 'Not met: ', items),
      });
  }
  return { constraints, notices };
}
export interface DeliveryRow {
  readonly cells: PublishCell[];
  readonly refs: string[];
  readonly pointer: string;
}
export interface DeliveryFinding {
  readonly text: string;
  readonly refs: string[];
  readonly pointer: string;
}
export interface UnmetItem {
  readonly item: string;
  readonly reason: string;
}
export interface DeliveryResult {
  readonly rows: DeliveryRow[];
  readonly findings: DeliveryFinding[];
  readonly alternativesRows: DeliveryRow[];
  readonly alternativesFindings: DeliveryFinding[];
  readonly gaps: string[];
  readonly issues: ComposeIssue[];
  readonly notices: BriefNotice[];
}
/** Exact normalized field grammar; spelling variants intentionally do not match. */
export function normalizeDeliveryName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}
export function columnMatchesField(column: string, field: string): boolean {
  const fieldTokens = normalizeDeliveryName(field).split(' ');
  const columnTokens = new Set(normalizeDeliveryName(column).split(' '));
  return fieldTokens.every((token) => columnTokens.has(token));
}
/** Bound list notices with a truthful overflow count, including the suffix in the cap. */
export function boundedNotice(
  prefix: string,
  items: readonly string[],
  maxItems = items.length,
): string {
  const visible: string[] = [];
  for (const item of items.slice(0, maxItems)) {
    const candidate = `${prefix}${[...visible, item].join('; ')}`;
    if (candidate.length + 24 > 600) break;
    visible.push(item);
  }
  const dropped = items.length - visible.length;
  return `${prefix}${visible.join('; ')}${dropped > 0 ? ` (+${dropped} more)` : ''}`;
}
/** Partition alternatives, fill empty required cells, and aggregate fulfillment gaps. */
export function checkContractDelivery(input: {
  readonly rows: readonly DeliveryRow[];
  readonly findings: readonly DeliveryFinding[];
  readonly columns: readonly string[];
  readonly tablePresent: boolean;
  readonly unmet: readonly UnmetItem[];
  readonly contract: TaskContractBody | null;
  readonly mode: 'tool' | 'assembled';
  readonly onContract: (refs: readonly string[]) => boolean;
}): DeliveryResult {
  const { contract } = input;
  const rows = input.rows.map((row) => ({ ...row, cells: [...row.cells] }));
  const issues: ComposeIssue[] = [];
  const runtimeGaps: string[] = [];
  const exempt = (name: string): boolean =>
    input.unmet.some((item) =>
      normalizeDeliveryName(item.item).includes(normalizeDeliveryName(name)),
    );
  if (contract?.deliverable === 'table') {
    if (!input.tablePresent && !exempt('table')) {
      if (input.mode === 'assembled') runtimeGaps.push('table: no table was published');
      else issues.push({ cause: 'contract-table-missing', pointer: 'table', values: {} });
    }
    if (input.tablePresent)
      for (const field of contract.required_fields) {
        const column = input.columns.findIndex((name) => columnMatchesField(name, field));
        if (column === -1) {
          if (!exempt(field)) {
            if (input.mode === 'assembled') runtimeGaps.push(`${field}: no column was published`);
            else
              issues.push({
                cause: 'contract-field-missing',
                pointer: 'table/columns',
                values: { field },
              });
          }
          continue;
        }
        let missing = 0;
        for (const row of rows)
          if (
            row.cells[column] === null ||
            row.cells[column] === '' ||
            row.cells[column] === NOT_SHOWN_ON_SOURCE
          ) {
            row.cells[column] = NOT_SHOWN_ON_SOURCE;
            missing += 1;
          }
        if (missing > 0)
          runtimeGaps.push(`${field}: not shown for ${missing} of ${rows.length} rows`);
      }
  }
  const partition = contract !== null && contract.required_sources.length > 0;
  const mainRows = rows.filter((row) => !partition || input.onContract(row.refs));
  const alternativesRows = rows.filter((row) => partition && !input.onContract(row.refs));
  const findings = input.findings.filter(
    (finding) => !partition || finding.refs.length === 0 || input.onContract(finding.refs),
  );
  const alternativesFindings = input.findings.filter(
    (finding) => partition && finding.refs.length > 0 && !input.onContract(finding.refs),
  );
  const hosts = contract?.required_sources.join(', ') ?? '';
  if (
    partition &&
    !mainRows.some((row) => input.onContract(row.refs)) &&
    !findings.some((finding) => finding.refs.length > 0 && input.onContract(finding.refs))
  )
    runtimeGaps.push(`nothing in the answer is cited from ${hosts}`);
  if (rows.length > 0 && mainRows.length === 0 && partition)
    runtimeGaps.push(`no row came from ${hosts}`);
  const gaps = [
    ...input.unmet.map((item) => `${item.item} (${item.reason})`),
    ...runtimeGaps.filter(
      (gap) =>
        !input.unmet.some((item) =>
          normalizeDeliveryName(gap).includes(normalizeDeliveryName(item.item)),
        ),
    ),
  ];
  const notices: BriefNotice[] =
    gaps.length === 0
      ? []
      : [
          {
            kind: 'contract_gap',
            source: 'task-contract',
            reason: boundedNotice('Not delivered: ', gaps),
          },
        ];
  return {
    rows: mainRows,
    findings,
    alternativesRows,
    alternativesFindings,
    gaps,
    issues,
    notices,
  };
}

/** Runtime-owned GFM alternatives section: same cells and explicit row citations. */
export function alternativesBody(
  columns: readonly string[],
  rows: readonly DeliveryRow[],
  findings: readonly DeliveryFinding[],
  markers: (refs: readonly string[]) => string,
  rewrite: (text: string) => string,
): string {
  const escape = (value: PublishCell): string =>
    (value === null ? '' : typeof value === 'boolean' ? (value ? '✓' : '✗') : String(value))
      .replace(/\|/gu, '\\|')
      .replace(/\r?\n/gu, ' ');
  const table =
    rows.length === 0
      ? ''
      : [
          `| ${[...columns, 'Sources'].map(escape).join(' | ')} |`,
          `| ${[...columns, 'Sources'].map(() => '---').join(' | ')} |`,
          ...rows.map((row) => `| ${[...row.cells.map(escape), markers(row.refs)].join(' | ')} |`),
        ].join('\n');
  const bullets = findings
    .map((finding) => `- ${rewrite(finding.text)} ${markers(finding.refs)}`)
    .join('\n');
  return [table, bullets].filter((block) => block.length > 0).join('\n\n');
}
