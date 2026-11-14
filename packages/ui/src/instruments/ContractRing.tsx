import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * ContractRing (FEAT-067): a run's declared requirements as one ring, one
 * segment per requirement in requirement order.
 *
 * - Each segment's state shows twice, never by color alone: by its stroke
 *   pattern (pending dotted, advancing dashed, met solid) and by a glyph at
 *   its middle (hollow, half-filled, filled).
 * - The ring is one image with a computed text alternative
 *   ("3 of 5 requirements met"); the RequirementList beside it names each one.
 * - With no requirements there is no ring at all.
 */

/** A requirement's live state (protocol `LiveItem.state`). */
export type RingSegmentState = 'pending' | 'advancing' | 'met';

/** One segment: a requirement and its state. */
export interface RingSegment {
  readonly id: string;
  readonly label: string;
  readonly state: RingSegmentState;
}

/** The ring's text alternative. */
export function contractRingLabel(segments: readonly RingSegment[]): string {
  const met = segments.filter((segment) => segment.state === 'met').length;
  return `${String(met)} of ${String(segments.length)} requirement${segments.length === 1 ? '' : 's'} met`;
}

const SIZE = 96;
const CENTER = SIZE / 2;
const RADIUS = 38;
const GLYPH_RADIUS = 4;
/** Degrees left empty between segments. */
const GAP = 6;

function point(angle: number, radius: number): [number, number] {
  const radians = ((angle - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(radians), CENTER + radius * Math.sin(radians)];
}

function round(value: number): string {
  return value.toFixed(2);
}

/** The arc path of one segment from `start` to `end` degrees (clockwise from the top). */
export function arcPath(start: number, end: number): string {
  if (end - start >= 359.99) {
    const [x, y] = point(0, RADIUS);
    const [bx, by] = point(180, RADIUS);
    return `M ${round(x)} ${round(y)} A ${String(RADIUS)} ${String(RADIUS)} 0 1 1 ${round(bx)} ${round(by)} A ${String(RADIUS)} ${String(RADIUS)} 0 1 1 ${round(x)} ${round(y)}`;
  }
  const [sx, sy] = point(start, RADIUS);
  const [ex, ey] = point(end, RADIUS);
  const large = end - start > 180 ? 1 : 0;
  return `M ${round(sx)} ${round(sy)} A ${String(RADIUS)} ${String(RADIUS)} 0 ${String(large)} 1 ${round(ex)} ${round(ey)}`;
}

const PATTERN: Readonly<Record<RingSegmentState, string>> = {
  pending: '1 5',
  advancing: '7 4',
  met: 'none',
};

const STROKE: Readonly<Record<RingSegmentState, string>> = {
  pending: 'stroke-ink-3',
  advancing: 'stroke-accent',
  met: 'stroke-signal-fulfilled',
};

function Glyph({
  angle,
  state,
}: {
  readonly angle: number;
  readonly state: RingSegmentState;
}): ReactNode {
  const [x, y] = point(angle, RADIUS);
  const ring = STROKE[state];
  if (state === 'met') {
    return (
      <circle
        cx={round(x)}
        cy={round(y)}
        r={GLYPH_RADIUS}
        strokeWidth={1.5}
        className={cn(ring, 'fill-signal-fulfilled')}
      />
    );
  }
  if (state === 'advancing') {
    // A half-filled disc: the left half filled.
    return (
      <g>
        <circle
          cx={round(x)}
          cy={round(y)}
          r={GLYPH_RADIUS}
          strokeWidth={1.5}
          className={cn(ring, 'fill-surface')}
        />
        <path
          d={`M ${round(x)} ${round(y - GLYPH_RADIUS)} A ${String(GLYPH_RADIUS)} ${String(GLYPH_RADIUS)} 0 0 0 ${round(x)} ${round(y + GLYPH_RADIUS)} Z`}
          className="fill-accent"
        />
      </g>
    );
  }
  return (
    <circle
      cx={round(x)}
      cy={round(y)}
      r={GLYPH_RADIUS}
      strokeWidth={1.5}
      className={cn(ring, 'fill-surface')}
    />
  );
}

export interface ContractRingProps {
  readonly segments: readonly RingSegment[];
  readonly className?: string;
}

/** See the module comment. */
export function ContractRing({ segments, className }: ContractRingProps): ReactNode {
  if (segments.length === 0) return null;
  const span = 360 / segments.length;
  const gap = segments.length === 1 ? 0 : GAP;
  const met = segments.filter((segment) => segment.state === 'met').length;
  return (
    <svg
      role="img"
      aria-label={contractRingLabel(segments)}
      viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
      width={SIZE}
      height={SIZE}
      data-instrument="contract-ring"
      className={cn('shrink-0', className)}
    >
      {segments.map((segment, index) => {
        const start = index * span + gap / 2;
        const end = (index + 1) * span - gap / 2;
        return (
          <g key={segment.id} data-segment={segment.id} data-state={segment.state}>
            <path
              d={arcPath(start, end)}
              fill="none"
              strokeWidth={6}
              strokeLinecap={segment.state === 'met' ? 'round' : 'butt'}
              strokeDasharray={PATTERN[segment.state]}
              className={STROKE[segment.state]}
            />
            <Glyph angle={(start + end) / 2} state={segment.state} />
          </g>
        );
      })}
      <text
        x={CENTER}
        y={CENTER}
        textAnchor="middle"
        dominantBaseline="central"
        className="type-engine fill-ink text-body"
      >
        {met}/{segments.length}
      </text>
    </svg>
  );
}
