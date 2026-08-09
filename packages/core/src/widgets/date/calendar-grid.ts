import type { WidgetContainer } from '../open-state.js';
import type { WidgetPort } from '../types.js';

/** How a calendar cell's date was obtained. */
export type CalendarDateDerivation = 'machine' | 'aria-label' | 'structural';

/** One visible day target read from a calendar table/grid. */
export interface CalendarCell {
  readonly day: number;
  readonly monthLabel: string;
  readonly derivedDate: string;
  readonly weekdayFromColumn: number | null;
  readonly weekdayFromDate: number;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly name: string;
  readonly group: string | null;
  readonly path: readonly number[];
  readonly derivation: CalendarDateDerivation;
  readonly unsafe: boolean;
}

/** Complete visible calendar read used by the calendar driver. */
export interface CalendarGridRead {
  readonly cells: readonly CalendarCell[];
  readonly displayedMonths: readonly string[];
  /** Whether the caller-supplied popup container still resolved in the DOM. */
  readonly containerResolved: boolean;
  /** Number of recognizable day cells produced by this read. */
  readonly cellsSeen: number;
  /** Month captions parsed even when no safe day cells were recognized. */
  readonly monthsParsed: readonly string[];
  /** Elements examined as possible day cells, used in diagnostic messages. */
  readonly elementsScanned: number;
}

/**
 * Read every visible day cell in calendar tables/grids.
 *
 * Date derivation is deliberately ordered from strongest to weakest:
 * machine-readable `data-date`/`data-day`/`datetime`/`value`, then a complete
 * date in `aria-label`, then structural month+year plus the bare day number.
 * Structural dates alone are checked against the grid's weekday header and
 * marked unsafe when the column and derived date disagree.
 */
export function readCalendarGrid(
  port: WidgetPort,
  container?: WidgetContainer,
): Promise<CalendarGridRead> {
  return port.evaluate((containerPath) => {
    const MONTHS = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const normalize = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const normalizeDateText = (value: string): string =>
      value
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const fromPath = (path: readonly number[] | undefined): ParentNode | null => {
      if (!path) return document;
      let current: Element | null = document.documentElement;
      for (const index of path) current = current?.children.item(index) ?? null;
      return current;
    };
    const toPath = (candidate: Element): number[] => {
      const result: number[] = [];
      let current: Element | null = candidate;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        if (!parent) return [];
        result.unshift(Array.prototype.indexOf.call(parent.children, current));
        current = parent;
      }
      return result;
    };
    const visible = (candidate: Element): boolean => {
      if (!(candidate instanceof HTMLElement) || candidate.hidden) return false;
      const style = window.getComputedStyle(candidate);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const iso = (year: number, month: number, day: number): string | null => {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        return null;
      }
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };
    const parseIso = (value: string | null): string | null => {
      const match = value?.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      return match ? iso(Number(match[1]), Number(match[2]), Number(match[3])) : null;
    };
    const localeCandidates = [
      document.documentElement.lang,
      ...navigator.languages,
      navigator.language,
      'en-US',
    ].filter(Boolean);
    const monthTokenMap = new Map<string, number>();
    for (const locale of new Set(localeCandidates)) {
      try {
        for (let month = 1; month <= 12; month += 1) {
          for (const width of ['long', 'short'] as const) {
            const formatter = new Intl.DateTimeFormat(locale, {
              month: width,
              timeZone: 'UTC',
            });
            const token = formatter
              .formatToParts(new Date(Date.UTC(2026, month - 1, 1)))
              .find((part) => part.type === 'month')?.value;
            if (token) monthTokenMap.set(normalizeDateText(token), month);
          }
        }
      } catch {
        // A malformed page lang must not break the safe English fallback.
      }
    }
    const monthTokens = [...monthTokenMap].sort(([left], [right]) => right.length - left.length);
    const parseNamedDate = (value: string | null): string | null => {
      if (!value) return null;
      const normalized = normalizeDateText(value);
      const matchedMonth = monthTokens.find(([token]) => ` ${normalized} `.includes(` ${token} `));
      if (!matchedMonth) return null;
      const year = /(?:^|\D)(\d{4})(?:\D|$)/.exec(value)?.[1];
      if (!year) return null;
      const withoutMonth = normalized.replace(matchedMonth[0], ' ');
      const day = withoutMonth
        .match(/\d{1,4}/g)
        ?.map(Number)
        .find((candidate) => candidate >= 1 && candidate <= 31);
      return day === undefined ? null : iso(Number(year), matchedMonth[1], day);
    };
    const parseMonth = (
      value: string | null,
    ): { label: string; year: number; month: number } | null => {
      if (!value) return null;
      const match = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i').exec(value);
      if (!match) return null;
      return {
        label: `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1).toLowerCase()} ${match[2]}`,
        year: Number(match[2]),
        month: MONTHS.indexOf(match[1]!.toLowerCase()) + 1,
      };
    };
    const labelledText = (candidate: Element): string => {
      const aria = candidate.getAttribute('aria-label');
      if (aria?.trim()) return normalize(aria);
      const ids = candidate.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
      return normalize(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    };
    /**
     * The cell's own label plus any label its non-decorative descendants declare.
     *
     * Pickers routinely put the full date on an inert child and leave the bare
     * day number on the clickable ancestor, so reading only the ancestor's own
     * `aria-label` discards the single unambiguous date on the page.
     *
     * Only an `aria-hidden` wrapper *inside* the cell marks a label decorative.
     * The search must not escape the cell: real pickers sit under app-level
     * containers that carry `aria-hidden="true"` while an overlay is up, and a
     * cell may carry it itself to mark an out-of-range date. Honouring either
     * discards every date on the page.
     */
    const cellLabelText = (candidate: Element): string => {
      const parts: string[] = [];
      const own = labelledText(candidate);
      if (own) parts.push(own);
      const descendants = candidate.querySelectorAll('[aria-label],[aria-labelledby]');
      for (const descendant of Array.from(descendants).slice(0, 8)) {
        const hiddenHost = descendant.closest('[aria-hidden="true"]');
        if (hiddenHost && hiddenHost !== candidate && candidate.contains(hiddenHost)) continue;
        const text = labelledText(descendant);
        if (text) parts.push(text);
      }
      return parts.join(' ').trim();
    };
    /**
     * Whether a cell is offered to the user at all.
     *
     * `aria-disabled` is the conventional marker, but a picker that removes
     * out-of-range dates from the accessibility tree instead expresses the same
     * thing with `aria-hidden="true"` on the cell and no disabled attribute of
     * any kind, so a reader that ignores it would click an inert date.
     */
    const unavailable = (candidate: Element | null): boolean =>
      candidate?.getAttribute('aria-disabled') === 'true' ||
      candidate?.getAttribute('aria-hidden') === 'true';
    const nearestHeading = (candidate: Element): string => {
      let current: Element | null = candidate;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const own = current.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (own && !own.contains(candidate)) return normalize(own.textContent);
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
            return normalize(sibling.textContent);
          }
          const nested = sibling.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]');
          if (nested) return normalize(nested.textContent);
          sibling = sibling.previousElementSibling;
        }
        current = current.parentElement;
      }
      return '';
    };
    const monthForGrid = (grid: Element): { label: string; year: number; month: number } | null => {
      const table = grid instanceof HTMLTableElement ? grid : grid.closest('table');
      const candidates = [
        table?.caption?.textContent ?? '',
        table?.querySelector<HTMLElement>('thead th[colspan]')?.textContent ?? '',
        labelledText(grid),
        table ? labelledText(table) : '',
      ];
      let ancestor: Element | null = grid.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth += 1) {
        candidates.push(labelledText(ancestor));
        ancestor = ancestor.parentElement;
      }
      candidates.push(nearestHeading(grid));
      // Many panels caption the month with a plain styled <span>, not a
      // heading, a <caption>, or an aria-label. Accept any preceding-sibling
      // text that parses as an exact "Month YYYY"; the strict pattern is what
      // keeps this from swallowing unrelated chrome.
      let scope: Element | null = grid;
      for (let depth = 0; scope && depth < 3; depth += 1) {
        let sibling = scope.previousElementSibling;
        for (let step = 0; sibling && step < 4; step += 1) {
          candidates.push(normalize(sibling.textContent));
          sibling = sibling.previousElementSibling;
        }
        scope = scope.parentElement;
      }
      for (const candidate of candidates) {
        const parsed = parseMonth(candidate);
        if (parsed) return parsed;
      }
      return null;
    };
    const headersFor = (grid: Element): number[] => {
      const headerNodes = Array.from(
        grid.querySelectorAll<HTMLElement>('thead th,[role="columnheader"]'),
      );
      return headerNodes.map((header) => {
        const token = normalize(header.getAttribute('aria-label') ?? header.textContent)
          .toLowerCase()
          .slice(0, 3);
        return WEEKDAYS.indexOf(token);
      });
    };
    const columnFor = (
      target: Element,
      owner: Element,
      headers: readonly number[],
    ): number | null => {
      const ariaColumn = owner.getAttribute('aria-colindex');
      const index = ariaColumn
        ? Number(ariaColumn) - 1
        : owner instanceof HTMLTableCellElement
          ? owner.cellIndex
          : Array.from(owner.parentElement?.children ?? []).indexOf(owner);
      const weekday = headers[index];
      if (weekday !== undefined && weekday >= 0) return weekday;
      const targetAriaColumn = target.getAttribute('aria-colindex');
      if (!targetAriaColumn) return null;
      const targetWeekday = headers[Number(targetAriaColumn) - 1];
      return targetWeekday !== undefined && targetWeekday >= 0 ? targetWeekday : null;
    };

    const root = fromPath(containerPath);
    if (!root) {
      return {
        cells: [],
        displayedMonths: [],
        containerResolved: false,
        cellsSeen: 0,
        monthsParsed: [],
        elementsScanned: 0,
      };
    }
    const grids = Array.from(root.querySelectorAll('table,[role="grid"]')).filter(visible);
    if (root instanceof Element && root.matches('table,[role="grid"]') && visible(root)) {
      grids.unshift(root);
    }
    const cells: {
      day: number;
      monthLabel: string;
      derivedDate: string;
      weekdayFromColumn: number | null;
      weekdayFromDate: number;
      disabled: boolean;
      selected: boolean;
      name: string;
      group: string | null;
      path: number[];
      derivation: 'machine' | 'aria-label' | 'structural';
      unsafe: boolean;
    }[] = [];
    const parsedMonths = new Set<string>();
    let elementsScanned = 0;
    for (const grid of [...new Set(grids)]) {
      const month = monthForGrid(grid);
      if (month) {
        parsedMonths.add(
          `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`,
        );
      }
      const headers = headersFor(grid);
      const rawTargets = Array.from(
        grid.querySelectorAll<HTMLElement>('button,[role="button"],[role="gridcell"],td'),
      ).filter(visible);
      elementsScanned += rawTargets.length;
      const targets = rawTargets.filter(
        (candidate) =>
          !rawTargets.some(
            (other) =>
              other !== candidate &&
              candidate.contains(other) &&
              /^\d{1,2}$/.test(normalize(other.textContent)),
          ),
      );
      for (const target of targets) {
        const owner = target.closest('td,[role="gridcell"]') ?? target;
        const labelText = cellLabelText(target) || cellLabelText(owner);
        const name = normalize(labelText || target.textContent);
        const dayText = /^\d{1,2}$/.test(normalize(target.textContent))
          ? normalize(target.textContent)
          : (/\b(\d{1,2})\b/.exec(name)?.[1] ?? '');
        const day = Number(dayText);
        if (!Number.isInteger(day) || day < 1 || day > 31) continue;
        const machineAttrs = ['data-date', 'data-day', 'datetime', 'value'] as const;
        let derived: string | null = null;
        for (const attribute of machineAttrs) {
          derived =
            parseIso(target.getAttribute(attribute)) ?? parseIso(owner.getAttribute(attribute));
          if (derived) break;
        }
        let derivation: 'machine' | 'aria-label' | 'structural' = 'machine';
        if (!derived) {
          derived = parseNamedDate(labelText);
          derivation = 'aria-label';
        }
        if (!derived && month) {
          derived = iso(month.year, month.month, day);
          derivation = 'structural';
        }
        if (!derived) continue;
        const date = new Date(`${derived}T00:00:00Z`);
        const weekdayFromDate = date.getUTCDay();
        const weekdayFromColumn = columnFor(target, owner, headers);
        const unsafe =
          derivation === 'structural' &&
          (weekdayFromColumn === null || weekdayFromColumn !== weekdayFromDate);
        cells.push({
          day,
          monthLabel: month?.label ?? derived.slice(0, 7),
          derivedDate: derived,
          weekdayFromColumn,
          weekdayFromDate,
          disabled:
            unavailable(target) ||
            unavailable(owner) ||
            ('disabled' in target && Boolean((target as HTMLButtonElement).disabled)),
          selected:
            target.getAttribute('aria-selected') === 'true' ||
            owner.getAttribute('aria-selected') === 'true',
          name,
          group: month?.label ?? null,
          path: toPath(target),
          derivation,
          unsafe,
        });
      }
    }

    // Some calendars expose no table/grid semantics at all. A complete date
    // in an aria label is stronger than structure, so accept those targets
    // directly and do not apply the weekday-column cross-check to them.
    const looseLabelled = Array.from(
      root.querySelectorAll<HTMLElement>('[aria-label],[aria-labelledby]'),
    ).filter(visible);
    elementsScanned += looseLabelled.length;
    const existingPaths = new Set(cells.map((cell) => cell.path.join('.')));
    for (const labelled of looseLabelled) {
      if (labelled.closest('table,[role="grid"]')) continue;
      if (
        labelled.hasAttribute('aria-controls') ||
        labelled.hasAttribute('aria-owns') ||
        labelled.hasAttribute('aria-haspopup')
      ) {
        continue;
      }
      const labelledDate = parseNamedDate(cellLabelText(labelled));
      if (!labelledDate) continue;
      const target = labelled.closest<HTMLElement>('button,[role="button"],[role="gridcell"],td');
      if (!target) continue;
      if (!visible(target)) continue;
      const path = toPath(target);
      if (path.length === 0 || existingPaths.has(path.join('.'))) continue;
      const day = Number(labelledDate.slice(8, 10));
      const date = new Date(`${labelledDate}T00:00:00Z`);
      const name = normalize(
        cellLabelText(target) || cellLabelText(labelled) || target.textContent,
      );
      cells.push({
        day,
        monthLabel: labelledDate.slice(0, 7),
        derivedDate: labelledDate,
        weekdayFromColumn: null,
        weekdayFromDate: date.getUTCDay(),
        disabled:
          unavailable(target) ||
          unavailable(target.closest('td,[role="gridcell"]')) ||
          ('disabled' in target && Boolean((target as HTMLButtonElement).disabled)),
        selected: target.getAttribute('aria-selected') === 'true',
        name,
        group: null,
        path,
        derivation: 'aria-label',
        unsafe: false,
      });
      existingPaths.add(path.join('.'));
      parsedMonths.add(labelledDate.slice(0, 7));
    }
    const displayedMonths = [...new Set(cells.map((cell) => cell.derivedDate.slice(0, 7)))].sort();
    return {
      cells,
      displayedMonths,
      containerResolved: containerPath !== undefined,
      cellsSeen: cells.length,
      monthsParsed: [...parsedMonths].sort(),
      elementsScanned,
    };
  }, container?.path);
}
