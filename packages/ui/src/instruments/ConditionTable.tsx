import type { BriefConstraint } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

import { StatusWord } from './RequirementList.js';

/**
 * ConditionTable (FEAT-066): a Brief's declared conditions with name, value,
 * the status word verbatim (`verified | unverified | violated`) and the
 * citation chips backing it.
 */

export interface ConditionTableProps {
  readonly constraints: readonly BriefConstraint[];
  /** Renders the citation chips of one condition. */
  readonly renderCitations?: (citations: readonly number[]) => ReactNode;
  /** An element id per row, so back-references can scroll to a condition. */
  readonly getRowId?: (index: number) => string;
  readonly className?: string;
}

/** See the module comment. */
export function ConditionTable({
  constraints,
  renderCitations,
  getRowId,
  className,
}: ConditionTableProps): ReactNode {
  if (constraints.length === 0) return null;
  return (
    <table className={cn('w-full border-collapse text-body', className)}>
      <caption className="type-label pb-2 text-start text-ink-2">Conditions</caption>
      <thead>
        <tr className="border-b border-rule text-start">
          <th scope="col" className="type-label px-2 py-1 text-start text-ink-2">
            Condition
          </th>
          <th scope="col" className="type-label px-2 py-1 text-start text-ink-2">
            Value
          </th>
          <th scope="col" className="type-label px-2 py-1 text-start text-ink-2">
            Status
          </th>
          <th scope="col" className="type-label px-2 py-1 text-start text-ink-2">
            Evidence
          </th>
        </tr>
      </thead>
      <tbody>
        {constraints.map((constraint, index) => (
          <tr
            key={`${constraint.name}-${String(index)}`}
            {...(getRowId === undefined ? {} : { id: getRowId(index) })}
            data-condition={constraint.name}
            className="border-b border-rule"
          >
            <th scope="row" className="px-2 py-1 text-start font-semibold text-ink">
              {constraint.name}
            </th>
            <td className="px-2 py-1 text-ink">{constraint.value}</td>
            <td className="px-2 py-1">
              <StatusWord word={constraint.status} />
            </td>
            <td className="px-2 py-1">
              {constraint.citations.length === 0 ? (
                <span className="text-ink-2">none</span>
              ) : (
                (renderCitations?.(constraint.citations) ??
                constraint.citations.map((n) => `[${String(n)}]`).join(' '))
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
