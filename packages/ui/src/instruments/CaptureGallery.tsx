import type { CaptureLabel } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

import { outcomeBadgeStyles } from './OutcomeBadge.js';

/**
 * CaptureGallery (FEAT-066): the capture files a run saved, grouped into
 * their capture sets (`part` of `parts`), with the set's `complete` state and
 * labels (`clipped_width`, `truncated`, `beyond_viewport`) as words.
 *
 * Images are never fetched here: the page passes `renderImage`, which loads
 * through a signed URL. A file over the image cap is never loaded at all; it
 * shows a placeholder and `renderOversize` (e.g. "Show in folder").
 */

/** Largest capture file the gallery loads (the registry's image cap). */
export const CAPTURE_IMAGE_CAP_BYTES = 20 * 1024 * 1024;

/** One capture file. */
export interface CaptureItem {
  /** Run-relative path. */
  readonly path: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** 1-based position in its capture set; a lone file is part 1 of 1. */
  readonly part?: number;
  readonly parts?: number;
  readonly complete?: boolean;
  readonly labels?: readonly CaptureLabel[];
  /** Audit only: whether the image was shown to the model provider. */
  readonly sentToModel?: boolean;
}

export interface CaptureGalleryProps {
  readonly items: readonly CaptureItem[];
  readonly renderImage: (item: CaptureItem) => ReactNode;
  readonly renderOversize?: (item: CaptureItem) => ReactNode;
  /** The path to show first and focus, e.g. from an action's capture link. */
  readonly selectedPath?: string;
  readonly imageCapBytes?: number;
  readonly className?: string;
}

/** Groups files into capture sets: a set starts at part 1 or when the last one is full. */
export function groupCaptureSets(items: readonly CaptureItem[]): CaptureItem[][] {
  const sets: CaptureItem[][] = [];
  for (const item of items) {
    const current = sets.at(-1);
    const part = item.part ?? 1;
    const full = current === undefined || current.length >= (current[0]?.parts ?? 1);
    if (part === 1 || full) sets.push([item]);
    else current.push(item);
  }
  return sets;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** See the module comment. */
export function CaptureGallery({
  items,
  renderImage,
  renderOversize,
  selectedPath,
  imageCapBytes = CAPTURE_IMAGE_CAP_BYTES,
  className,
}: CaptureGalleryProps): ReactNode {
  if (items.length === 0) {
    return <p className="text-ink-2">No captures recorded for this run.</p>;
  }
  const sets = groupCaptureSets(items);
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {sets.map((set, setIndex) => {
        const first = set[0]!;
        const parts = first.parts ?? set.length;
        const complete = first.complete;
        const labels = first.labels ?? [];
        const headingId = `capture-set-${String(setIndex + 1)}`;
        return (
          <section
            key={first.path}
            aria-labelledby={headingId}
            data-capture-set={setIndex + 1}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={headingId} className="font-semibold text-ink">
                Capture set {setIndex + 1} — {parts} {parts === 1 ? 'part' : 'parts'}
              </h3>
              {complete === undefined ? null : (
                <span
                  data-part="complete"
                  className={outcomeBadgeStyles({ tone: complete ? 'fulfilled' : 'caution' })}
                >
                  <Icon name={complete ? 'outcome.fulfilled' : 'outcome.partial'} size={16} />
                  <span>{complete ? 'complete' : 'incomplete'}</span>
                </span>
              )}
              {labels.map((label) => (
                <span
                  key={label}
                  data-part="label"
                  className={outcomeBadgeStyles({ tone: 'neutral' })}
                >
                  {label}
                </span>
              ))}
            </div>
            <ul className="flex flex-wrap gap-3">
              {set.map((item) => (
                <li
                  key={item.path}
                  data-capture={item.path}
                  {...(item.path === selectedPath ? { 'data-selected': 'true' } : {})}
                  className={cn(
                    'flex w-64 flex-col gap-1 rounded-control border border-rule p-2',
                    item.path === selectedPath && 'border-accent',
                  )}
                >
                  {item.bytes > imageCapBytes ? (
                    <div data-part="oversize" className="flex flex-col gap-1 text-ink-2">
                      <span>Too large to show here ({megabytes(item.bytes)}).</span>
                      {renderOversize?.(item)}
                    </div>
                  ) : (
                    renderImage(item)
                  )}
                  <span className="type-engine truncate text-caption text-ink-2">{item.path}</span>
                  {item.part === undefined ? null : (
                    <span className="text-caption text-ink-2">
                      Part {item.part} of {parts}
                    </span>
                  )}
                  {item.sentToModel === undefined ? null : (
                    <span data-part="destination" className="text-caption text-ink-2">
                      {item.sentToModel ? 'sent to model' : 'kept on this computer'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
