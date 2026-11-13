/**
 * Why a run ended (FEAT-066 TASK-004), from the first source that recorded
 * it, in this order:
 *
 * 1. the last `run_outcome` in `run-events.jsonl` (FEAT-063);
 * 2. the manifest's `terminationReason`, `failureClass` and `agentError`;
 * 3. the last `task_failed` or `human_handoff_requested` in `events.jsonl`;
 * 4. the first failure or handoff section of `report.md`.
 *
 * Every read is a bounded tail ({@link TERMINAL_TAIL_BYTES}). Text is
 * ANSI-stripped and cut to `TERMINAL_TEXT_MAX` characters; `source` records
 * which reader answered.
 */

import { join } from 'node:path';

import {
  TERMINAL_TEXT_MAX,
  TerminationReason,
  parseRunEventLine,
  type TerminalReason,
} from '@yantra/protocol';

import { readTail, type BoundedReadFs } from './bounded-read.js';

/** The most bytes read from the end of each source. */
export const TERMINAL_TAIL_BYTES = 256 * 1024;

/** The manifest fields the manifest reader uses. */
export interface TerminalManifestFields {
  readonly terminationReason: string | null;
  readonly failureClass: string | null;
  readonly agentError: { readonly code: string; readonly message: string } | null;
}

// ESC-introduced sequences (CSI, OSC) and the remaining C0/C1 control bytes.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/gu;
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** ANSI-stripped, control-free and cut to {@link TERMINAL_TEXT_MAX} characters. */
export function boundedText(value: string): string {
  const clean = value.replace(ANSI, '').replace(CONTROL, '').trim();
  return clean.length > TERMINAL_TEXT_MAX ? `${clean.slice(0, TERMINAL_TEXT_MAX - 1)}…` : clean;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = boundedText(value);
  return text.length === 0 ? undefined : text;
}

function terminationOf(value: unknown): TerminalReason['termination_reason'] {
  const parsed = TerminationReason.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Drops undefined fields, so the reason only carries what was recorded. */
function compact(reason: TerminalReason): TerminalReason {
  return Object.fromEntries(
    Object.entries(reason).filter(([, value]) => value !== undefined),
  ) as TerminalReason;
}

function lines(text: string | null): string[] {
  if (text === null) return [];
  // A trailing partial line (no newline yet) is not a complete record.
  const parts = text.split('\n');
  parts.pop();
  return parts.filter((line) => line.trim().length > 0);
}

async function fromRunEvents(runDir: string, fs?: BoundedReadFs): Promise<TerminalReason | null> {
  const tail = await readTail(join(runDir, 'run-events.jsonl'), TERMINAL_TAIL_BYTES, fs);
  for (const line of lines(tail).reverse()) {
    const item = parseRunEventLine(line);
    if (item.status !== 'event' || item.record.event.kind !== 'run_outcome') continue;
    const event = item.record.event;
    return compact({
      source: 'run_outcome',
      failure_class: optionalText(event.failure_class ?? undefined),
      termination_reason: terminationOf(event.termination_reason),
      message: optionalText(event.stop_detail ?? undefined),
    });
  }
  return null;
}

function fromManifest(manifest: TerminalManifestFields | null): TerminalReason | null {
  if (manifest === null) return null;
  const { terminationReason, failureClass, agentError } = manifest;
  if (terminationReason === null && failureClass === null && agentError === null) return null;
  return compact({
    source: 'manifest',
    failure_class: optionalText(failureClass ?? agentError?.code),
    message: optionalText(agentError?.message),
    termination_reason: terminationOf(terminationReason),
  });
}

async function fromEvents(runDir: string, fs?: BoundedReadFs): Promise<TerminalReason | null> {
  const tail = await readTail(join(runDir, 'events.jsonl'), TERMINAL_TAIL_BYTES, fs);
  for (const line of lines(tail).reverse()) {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.kind === 'task_failed') {
      return compact({ source: 'events', failure_class: optionalText(event.failure_class) });
    }
    if (event.kind === 'human_handoff_requested' || event.kind === 'handoff_required') {
      return compact({
        source: 'events',
        blocker: optionalText(event.reason),
        message: optionalText(event.message),
      });
    }
  }
  return null;
}

const SECTION = /^##\s+(Failure|Handoff|Error)\b.*$/imu;
const NONE = new Set(['none', 'n/a', '']);

function field(section: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*(.+)$`, 'imu').exec(section);
  const value = match?.[1]?.trim();
  return value === undefined || NONE.has(value.toLowerCase()) ? undefined : optionalText(value);
}

async function fromReport(runDir: string, fs?: BoundedReadFs): Promise<TerminalReason | null> {
  const text = await readTail(join(runDir, 'report.md'), TERMINAL_TAIL_BYTES, fs);
  if (text === null) return null;
  const heading = SECTION.exec(text);
  if (heading === null) return null;
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^##\s/mu.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const reason = compact({
    source: 'report',
    failure_class: field(section, 'Failure class'),
    message: field(section, 'Cause') ?? field(section, 'Message') ?? field(section, 'Error'),
    blocker: field(section, 'Blocker'),
    safest_next_action: field(section, 'Safest next action'),
  });
  return Object.keys(reason).length > 1 ? reason : null;
}

/** Why the run ended, or null when no source recorded it; see the module comment. */
export async function readTerminalReason(
  runDir: string,
  manifest: TerminalManifestFields | null,
  fs?: BoundedReadFs,
): Promise<TerminalReason | null> {
  return (
    (await fromRunEvents(runDir, fs)) ??
    fromManifest(manifest) ??
    (await fromEvents(runDir, fs)) ??
    (await fromReport(runDir, fs))
  );
}
