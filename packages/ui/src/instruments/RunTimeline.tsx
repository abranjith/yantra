import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { GridList, GridListItem, ListLayout, Virtualizer } from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn, focusRing } from '../lib/cn.js';

/**
 * RunTimeline (FEAT-067): what the engine did, newest at the bottom, in the
 * mono engine voice.
 *
 * - Tool calls show their start and, once finished, their status as a glyph
 *   **and** a word (`running`, `ok`, `error`, `denied`, `aborted`), never
 *   color alone. The current call is marked.
 * - Recovery steers and deterministic phases (search, fetch, extract,
 *   synthesize) have their own row shapes.
 * - Virtualized (React Aria GridList in a Virtualizer), so 2,000 rows render a
 *   bounded DOM. While the view sits at the bottom it follows new rows; a
 *   reader who scrolled up stays where they are. New rows never move focus.
 * - All text is page- or model-derived and renders through React escaping.
 */

/** How a tool call stands. */
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'aborted';

/** A deterministic `ask`/`research` phase. */
export type Phase = 'search' | 'fetch' | 'extract' | 'synthesize';

/** The tone of a workflow or advisory row. */
export type RowTone = 'neutral' | 'ok' | 'warn' | 'error';

/** One timeline row; `seq` is the event that created it (its key). */
export type RunTimelineEntry =
  | {
      readonly type: 'tool';
      readonly seq: number;
      readonly tool: string;
      readonly summary: string;
      readonly status: ToolStatus;
      /** The finish summary (status and error code only), once finished. */
      readonly result: string | null;
      readonly durationMs: number | null;
      readonly at: string;
    }
  | {
      readonly type: 'recovery';
      readonly seq: number;
      readonly rung: 'steer' | 'freeze' | 'stop';
      readonly trigger: 'stalled' | 'turn-timeout';
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'phase';
      readonly seq: number;
      readonly phase: Phase;
      readonly text: string;
      readonly at: string;
    }
  | {
      readonly type: 'step';
      readonly seq: number;
      readonly kind: string;
      readonly text: string;
      readonly tone: RowTone;
      readonly at: string;
    };

const STATUS_ICON: Readonly<Record<ToolStatus, IconName>> = {
  running: 'glyph.bindu',
  ok: 'outcome.fulfilled',
  error: 'outcome.failed',
  denied: 'status.needsYou',
  aborted: 'outcome.aborted',
};

const STATUS_TONE: Readonly<Record<ToolStatus, string>> = {
  running: 'text-accent-ink',
  ok: 'text-signal-fulfilled-ink',
  error: 'text-signal-failed-ink',
  denied: 'text-signal-needs-you-ink',
  aborted: 'text-ink-2',
};

const TONE_ICON: Readonly<Record<RowTone, IconName>> = {
  neutral: 'status.info',
  ok: 'outcome.fulfilled',
  warn: 'outcome.partial',
  error: 'outcome.failed',
};

const TONE_CLASS: Readonly<Record<RowTone, string>> = {
  neutral: 'text-ink-2',
  ok: 'text-signal-fulfilled-ink',
  warn: 'text-signal-partial-ink',
  error: 'text-signal-failed-ink',
};

const TONE_WORD: Readonly<Record<RowTone, string>> = {
  neutral: 'note',
  ok: 'done',
  warn: 'warning',
  error: 'failed',
};

/** A status glyph with its word: never color alone. */
function StatusMark({
  icon,
  word,
  tone,
}: {
  readonly icon: IconName;
  readonly word: string;
  readonly tone: string;
}): ReactNode {
  return (
    <span data-part="status" className={cn('inline-flex shrink-0 items-center gap-1', tone)}>
      <Icon name={icon} size={16} />
      <span>{word}</span>
    </span>
  );
}

function rowText(entry: RunTimelineEntry): string {
  switch (entry.type) {
    case 'tool': {
      const detail = [entry.summary, entry.result].filter((part) => part !== null && part !== '');
      const timing = entry.durationMs === null ? '' : ` (${String(entry.durationMs)} ms)`;
      return `${entry.tool}${detail.length > 0 ? ` ${detail.join(' -> ')}` : ''}${timing}`;
    }
    case 'recovery':
      return `recovery ${entry.rung} (${entry.trigger}): ${entry.summary}`;
    case 'phase':
      return entry.text;
    case 'step':
      return entry.text;
  }
}

function Mark({ entry }: { readonly entry: RunTimelineEntry }): ReactNode {
  switch (entry.type) {
    case 'tool':
      return (
        <StatusMark
          icon={STATUS_ICON[entry.status]}
          word={entry.status}
          tone={STATUS_TONE[entry.status]}
        />
      );
    case 'recovery':
      return <StatusMark icon="action.retry" word={entry.rung} tone="text-signal-partial-ink" />;
    case 'phase':
      return <StatusMark icon="nav.chevronRight" word={entry.phase} tone="text-ink-2" />;
    case 'step':
      return (
        <StatusMark
          icon={TONE_ICON[entry.tone]}
          word={TONE_WORD[entry.tone]}
          tone={TONE_CLASS[entry.tone]}
        />
      );
  }
}

/** The accessible text of one row: its status word and its text. */
export function timelineRowLabel(entry: RunTimelineEntry): string {
  const word =
    entry.type === 'tool'
      ? entry.status
      : entry.type === 'recovery'
        ? entry.rung
        : entry.type === 'phase'
          ? entry.phase
          : TONE_WORD[entry.tone];
  return `${word}: ${rowText(entry)}`;
}

export interface RunTimelineProps {
  /** Rows, oldest first. */
  readonly entries: readonly RunTimelineEntry[];
  /** Rows written before the oldest one shown (they are in the run's files). */
  readonly omitted?: number;
  /** The `seq` of the call in progress, marked as current. */
  readonly currentSeq?: number | null;
  /** Fixed row height in px, so the virtualizer never measures. Default 32. */
  readonly rowHeight?: number;
  /** The scroll viewport's height (any CSS length). Default 20rem. */
  readonly height?: string;
  readonly 'aria-label'?: string;
  readonly className?: string;
}

/** See the module comment. */
export function RunTimeline({
  entries,
  omitted = 0,
  currentSeq = null,
  rowHeight = 32,
  height = '20rem',
  'aria-label': label = 'Engine timeline',
  className,
}: RunTimelineProps): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    const onScroll = (): void => {
      atBottom.current = list.scrollTop + list.clientHeight >= list.scrollHeight - rowHeight;
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      list.removeEventListener('scroll', onScroll);
    };
  }, [rowHeight]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null || !atBottom.current) return;
    // Follow new rows only while the reader is already at the bottom; never move focus.
    list.scrollTop = list.scrollHeight;
  }, [entries]);

  return (
    <div className={cn('flex flex-col gap-1', className)} data-instrument="timeline">
      {omitted > 0 ? (
        <p className="text-caption text-ink-2">
          {omitted} earlier {omitted === 1 ? 'entry is' : 'entries are'} in the run’s event log.
        </p>
      ) : null}
      <div
        style={{ '--timeline-height': height } as CSSProperties}
        className="h-(--timeline-height) overflow-hidden rounded-control border border-rule bg-surface"
      >
        <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight }}>
          <GridList
            ref={listRef}
            aria-label={label}
            layout="stack"
            renderEmptyState={() => (
              <p className="flex h-full items-center justify-center p-4 text-ink-2">
                No engine activity yet.
              </p>
            )}
            className={focusRing({ className: 'h-full w-full overflow-auto -outline-offset-2' })}
          >
            {entries.map((entry) => {
              const current = entry.type === 'tool' && entry.seq === currentSeq;
              return (
                <GridListItem
                  key={entry.seq}
                  id={entry.seq}
                  textValue={timelineRowLabel(entry)}
                  data-seq={entry.seq}
                  data-type={entry.type}
                  {...(current ? { 'data-current': 'true' } : {})}
                  className={focusRing({
                    className: cn(
                      'type-engine flex items-center border-b border-rule px-3 text-ink -outline-offset-2',
                      current && 'bg-sunken',
                      entry.type === 'recovery' && 'border-l-2 border-l-signal-partial',
                    ),
                  })}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Mark entry={entry} />
                    <span className="min-w-0 flex-1 truncate">{rowText(entry)}</span>
                    {current ? (
                      <span className="shrink-0 text-caption text-accent-ink">current</span>
                    ) : null}
                  </div>
                </GridListItem>
              );
            })}
          </GridList>
        </Virtualizer>
      </div>
    </div>
  );
}
