import { z } from 'zod';

import { SCREENSHOT_ARTIFACT_PATH_PATTERN } from './artifact-ref.js';

/**
 * Run identity and the public-artifact allowlist (FEAT-066 TASK-001).
 *
 * The app reaches a run directory only through this module: a {@link RunId}
 * is validated before any filesystem call, and a run-relative path is served
 * only when {@link classifyRunArtifact} matches it to an allowed entry of
 * {@link RUN_ARTIFACT_REGISTRY}. Matching is first-match-wins, explicit
 * denials come first, and anything unmatched is denied.
 */

/** The run-id grammar `formatRunId` produces: `<yyyymmdd>T<hhmmss>Z-<name>-<short id>`. */
export const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9-]+$/;

/** The longest run id accepted. */
export const RUN_ID_MAX_LENGTH = 96;

/** A run id: no separators, no `..`, no drive letters. */
export const RunId = z
  .string()
  .max(RUN_ID_MAX_LENGTH)
  .regex(RUN_ID_PATTERN)
  .describe('A run id, e.g. `20260511T091234Z-bank-statement-a7b3`; names `runs/<run_id>/`.');
export type RunId = z.infer<typeof RunId>;

/** True when `value` is a well-formed {@link RunId}. */
export function isRunId(value: string): boolean {
  return value.length <= RUN_ID_MAX_LENGTH && RUN_ID_PATTERN.test(value);
}

/** How the app may reach a run file. */
export const RunArtifactExposure = z
  .enum(['typed', 'view', 'download', 'denied'])
  .describe(
    'typed: only through a typed read (e.g. brief.json through read.run_result); view: through a bounded viewer; download: only as an attachment; denied: never served.',
  );
export type RunArtifactExposure = z.infer<typeof RunArtifactExposure>;

/** Which bounded viewer opens a run file. */
export const RunArtifactViewer = z
  .enum(['brief', 'document', 'markdown', 'json', 'jsonl', 'text', 'image', 'none'])
  .describe('The bounded viewer that opens the file; `none` when no viewer exists.');
export type RunArtifactViewer = z.infer<typeof RunArtifactViewer>;

/** The only media types the host may send for a run file. */
export const RUN_ARTIFACT_MEDIA_TYPES = [
  'application/json; charset=utf-8',
  'application/x-ndjson; charset=utf-8',
  'text/markdown; charset=utf-8',
  'text/html; charset=utf-8',
  'text/plain; charset=utf-8',
  'image/png',
  'application/octet-stream',
] as const;

/** One entry of the public allowlist. */
export const RunArtifactRegistryEntry = z
  .object({
    id: z.string().min(1).describe('Stable entry name, e.g. `brief.json` or `screenshots`.'),
    pattern: z
      .string()
      .min(1)
      .describe('Run-relative, forward-slash glob (`*` within a segment, `**` across segments).'),
    exposure: RunArtifactExposure,
    viewer: RunArtifactViewer,
    media_type: z
      .enum(RUN_ARTIFACT_MEDIA_TYPES)
      .describe('The only Content-Type the host may send for the entry.'),
    inline_cap_bytes: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        'Largest file a viewer may load whole; above it the item is too_large. Null: windowed, or never loaded inline.',
      ),
    description: z.string().min(1).describe('What the file is, for generated docs and parity.'),
  })
  .strict()
  .describe('One entry of the public run-artifact allowlist.');
export type RunArtifactRegistryEntry = z.infer<typeof RunArtifactRegistryEntry>;

const KIB = 1_024;
const MIB = 1_024 * KIB;

const JSON_TYPE = 'application/json; charset=utf-8';
const JSONL_TYPE = 'application/x-ndjson; charset=utf-8';
const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const PNG_TYPE = 'image/png';

function deny(pattern: string, description: string): RunArtifactRegistryEntry {
  return {
    id: `deny:${pattern}`,
    pattern,
    exposure: 'denied',
    viewer: 'none',
    media_type: 'application/octet-stream',
    inline_cap_bytes: null,
    description,
  };
}

function jsonView(id: string, description: string): RunArtifactRegistryEntry {
  return {
    id,
    pattern: id,
    exposure: 'view',
    viewer: 'json',
    media_type: JSON_TYPE,
    inline_cap_bytes: 2 * MIB,
    description,
  };
}

function jsonlView(id: string, pattern: string, description: string): RunArtifactRegistryEntry {
  return {
    id,
    pattern,
    exposure: 'view',
    viewer: 'jsonl',
    media_type: JSONL_TYPE,
    inline_cap_bytes: null,
    description,
  };
}

/** The entry every unmatched or unsafe path classifies to. */
export const DENIED_RUN_ARTIFACT: RunArtifactRegistryEntry = deny(
  '**',
  'Default deny: a run file no allowlist entry names is never served or listed.',
);

/**
 * The public allowlist (plan_ui §7). Explicit denials first, then allowed
 * entries; {@link classifyRunArtifact} takes the first match and denies
 * anything unmatched.
 */
export const RUN_ARTIFACT_REGISTRY: readonly RunArtifactRegistryEntry[] = [
  deny('lease.json', 'The run lease: owner identity and socket address (FEAT-064).'),
  deny('reconcile.lock', 'The reconciler’s claim on the run.'),
  deny('.lock', 'The run directory lock.'),
  deny('**/*.lock', 'Any lock file.'),
  deny('**/*.mutex', 'Any mutex file.'),
  deny('decisions/**', 'Parked-decision claims (FEAT-068).'),
  deny('*.tmp', 'Atomic-write staging files.'),
  deny('**/*.tmp', 'Atomic-write staging files in a subdirectory.'),
  deny('**/*.sock', 'Run sockets.'),
  deny('**/chrome-profile/**', 'A browser profile.'),
  deny('**/browser-profile/**', 'A browser profile.'),
  deny('**/user-data/**', 'A browser profile.'),
  deny('**/user-data-dir/**', 'A browser profile.'),
  {
    id: 'brief.json',
    pattern: 'brief.json',
    exposure: 'typed',
    viewer: 'brief',
    media_type: JSON_TYPE,
    inline_cap_bytes: 512 * KIB,
    description: 'The Brief (ask, research, do): read through read.run_result.',
  },
  {
    id: 'brief.md',
    pattern: 'brief.md',
    exposure: 'view',
    viewer: 'markdown',
    media_type: MARKDOWN_TYPE,
    inline_cap_bytes: 2 * MIB,
    description: 'The Brief as Markdown.',
  },
  {
    id: 'brief.html',
    pattern: 'brief.html',
    exposure: 'download',
    viewer: 'none',
    media_type: HTML_TYPE,
    inline_cap_bytes: null,
    description: 'The Brief as a standalone HTML page; download only, never rendered in the app.',
  },
  {
    id: 'document.json',
    pattern: 'document.json',
    exposure: 'typed',
    viewer: 'document',
    media_type: JSON_TYPE,
    inline_cap_bytes: 512 * KIB,
    description: 'A templated report: read through read.run_result.',
  },
  {
    id: 'document.md',
    pattern: 'document.md',
    exposure: 'view',
    viewer: 'markdown',
    media_type: MARKDOWN_TYPE,
    inline_cap_bytes: 2 * MIB,
    description: 'The templated report as Markdown.',
  },
  {
    id: 'document.html',
    pattern: 'document.html',
    exposure: 'download',
    viewer: 'none',
    media_type: HTML_TYPE,
    inline_cap_bytes: null,
    description: 'The templated report as HTML; download only, never rendered in the app.',
  },
  {
    id: 'report.md',
    pattern: 'report.md',
    exposure: 'view',
    viewer: 'markdown',
    media_type: MARKDOWN_TYPE,
    inline_cap_bytes: 512 * KIB,
    description: 'The run report (`yantra report`).',
  },
  jsonView('outputs.json', 'A workflow run’s declared outputs.'),
  jsonView('manifest.json', 'The run manifest: identity, status, outcome and provenance.'),
  jsonView('usage.json', 'Provider usage: turns, tokens and cost.'),
  jsonView('run-health.json', 'Run health counters: searches, fetches, failures, budgets.'),
  jsonView('contract.json', 'The task contract the run worked to.'),
  jsonView('trace.json', 'The replay trace.'),
  jsonView('schedule.json', 'The schedule that fired the run.'),
  jsonView(
    'execution-receipt.json',
    'Effective non-secret settings and content identities (FEAT-072).',
  ),
  jsonlView('events.jsonl', 'events.jsonl', 'Workflow task events.'),
  jsonlView('run-events.jsonl', 'run-events.jsonl', 'The unified run-event stream (FEAT-063).'),
  jsonlView('runtime.jsonl', 'runtime.jsonl', 'Runtime diagnostics.'),
  jsonlView('tool-calls.jsonl', 'tool-calls.jsonl', 'Sanitized tool-call lifecycle records.'),
  jsonlView('confirmations.jsonl', 'confirmations.jsonl', 'Confirmation requests and decisions.'),
  jsonlView('secrets.jsonl', 'secrets.jsonl', 'Secret lookups: key names only, never values.'),
  jsonlView('interventions.jsonl', 'interventions.jsonl', 'Interventions raised and resolved.'),
  jsonlView('agent.jsonl', 'agent.jsonl', 'The legacy agent log.'),
  jsonlView('agent-session', 'agent/*.jsonl', 'The provider session log.'),
  {
    id: 'screenshots',
    pattern: 'screenshots/*.png',
    exposure: 'view',
    viewer: 'image',
    media_type: PNG_TYPE,
    inline_cap_bytes: 20 * MIB,
    description: 'Captures and Vision Assist screenshots; names must match the capture grammar.',
  },
  {
    id: 'capture-text',
    pattern: 'captures/cap-*.txt',
    exposure: 'view',
    viewer: 'text',
    media_type: TEXT_TYPE,
    inline_cap_bytes: 2 * MIB,
    description: 'Extracted page text kept on this computer.',
  },
  {
    id: 'capture-images',
    pattern: 'captures/*.png',
    exposure: 'view',
    viewer: 'image',
    media_type: PNG_TYPE,
    inline_cap_bytes: 20 * MIB,
    description: 'Capture images kept on this computer.',
  },
];

/** Extra per-entry grammar a glob cannot express. */
const ENTRY_GRAMMARS: Readonly<Record<string, RegExp>> = {
  screenshots: SCREENSHOT_ARTIFACT_PATH_PATTERN,
};

function segmentPattern(segment: string): RegExp {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'u');
}

function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
  pi: number,
  si: number,
): boolean {
  if (pi === pattern.length) return si === path.length;
  const head = pattern[pi]!;
  if (head === '**') {
    for (let skip = si; skip <= path.length; skip += 1) {
      if (matchSegments(pattern, path, pi + 1, skip)) return true;
    }
    return false;
  }
  if (si === path.length) return false;
  return segmentPattern(head).test(path[si]!) && matchSegments(pattern, path, pi + 1, si + 1);
}

/** True when a run-relative, normalized path matches a registry glob. */
export function matchRunArtifactPattern(pattern: string, relPath: string): boolean {
  return matchSegments(pattern.split('/'), relPath.split('/'), 0, 0);
}

/**
 * Normalizes a client path to forward slashes, or null when it is unsafe:
 * empty, absolute, a drive path, a UNC or backslash path, NUL, empty
 * segments, `.` or `..`, or a percent-encoded dot segment.
 */
export function normalizeRunArtifactPath(relPath: string): string | null {
  if (relPath.length === 0 || relPath.length > 512) return null;
  if (relPath.includes('\0') || relPath.includes('\\')) return null;
  if (relPath.startsWith('/') || /^[A-Za-z]:/u.test(relPath)) return null;
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    // A literal `%2e%2e` is never decoded here, but it is never a real run file either.
    if (/%2e|%2f|%5c/iu.test(segment)) return null;
  }
  return segments.join('/');
}

/**
 * Classifies a run-relative path against {@link RUN_ARTIFACT_REGISTRY}:
 * the first matching entry, or {@link DENIED_RUN_ARTIFACT}. Unsafe paths
 * (see {@link normalizeRunArtifactPath}) are always denied.
 */
export function classifyRunArtifact(relPath: string): RunArtifactRegistryEntry {
  const normalized = normalizeRunArtifactPath(relPath);
  if (normalized === null) return DENIED_RUN_ARTIFACT;
  for (const entry of RUN_ARTIFACT_REGISTRY) {
    if (!matchRunArtifactPattern(entry.pattern, normalized)) continue;
    const grammar = ENTRY_GRAMMARS[entry.id];
    if (grammar !== undefined && !grammar.test(normalized)) return DENIED_RUN_ARTIFACT;
    return entry;
  }
  return DENIED_RUN_ARTIFACT;
}

/** The registry as one array, for JSON Schema emission and the FEAT-070 parity test. */
export const RunArtifactRegistry = z
  .array(RunArtifactRegistryEntry)
  .describe('The public run-artifact allowlist, in match order.');
