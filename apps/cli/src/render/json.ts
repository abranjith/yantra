/**
 * Stable JSON renderer for the Yantra CLI.
 *
 * Every output object carries `schemaVersion: "0.1"` so downstream tooling
 * can pin against the surface. Streamed events are emitted as JSON Lines
 * (one event per line); final outcomes are emitted as a single JSON object.
 */

import type { TaskEvent } from '@yantra/protocol';

import type {
  AuditRenderReport,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './types.js';

export const CLI_JSON_SCHEMA_VERSION = '0.1' as const;

export class JSONRenderer implements OutputRenderer {
  renderList(items: readonly ListItem[], opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'list', items })}\n`,
    );
  }

  renderShow(item: ShowItem, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'show', item })}\n`,
    );
  }

  renderDoctor(result: DoctorRenderResult, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'doctor', ...result })}\n`,
    );
  }

  renderAudit(report: AuditRenderReport, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'audit', ...report })}\n`,
    );
  }

  renderReport(markdown: string, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'report', markdown })}\n`,
    );
  }

  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'event', event })}\n`,
    );
  }
}
