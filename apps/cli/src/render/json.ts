/**
 * Stable JSON renderer for the Yantra CLI.
 *
 * Every output object carries a `schemaVersion` (the current protocol
 * schema version) so downstream tooling can pin against the surface.
 * Streamed events are emitted as JSON Lines (one event per line); final
 * outcomes are emitted as a single JSON object.
 */

import type { Brief, TaskEvent, TemplatedReport } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';

import type {
  AuditRenderReport,
  BriefArtifactPaths,
  ConnectorRenderOpts,
  DoctorRenderResult,
  DoctorSmokeRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './types.js';

export const CLI_JSON_SCHEMA_VERSION = SCHEMA_VERSION;

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

  renderDoctorSmoke(result: DoctorSmokeRenderResult, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'doctor_smoke', ...result })}\n`,
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

  /**
   * Emits the Brief verbatim inside the schema envelope. This is the
   * dependency-free `--json` surface (plan §8): key order is fixed
   * (`schemaVersion`, `kind`, `brief`, `artifacts`) so the same Brief always
   * serializes to identical bytes.
   */
  renderBrief(brief: Brief, artifacts: BriefArtifactPaths | null, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'brief', brief, artifacts })}\n`,
    );
  }

  renderTemplatedReport(
    report: TemplatedReport,
    artifacts: BriefArtifactPaths | null,
    opts: ConnectorRenderOpts,
  ): void {
    opts.stream.write(
      `${JSON.stringify({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        kind: 'templated_report',
        ...report,
        artifacts,
      })}\n`,
    );
  }

  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void {
    opts.stream.write(
      `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: 'event', event })}\n`,
    );
  }
}
