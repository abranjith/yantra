import { APP_READ_SCHEMAS } from '@yantra/protocol/parity';
import { describe, expect, it } from 'vitest';

import {
  deriveColumns,
  humanize,
  recordBody,
  resolvePointer,
  rowsOf,
  tableShape,
  TableShapeError,
  type SchemaLike,
} from '../../src/generated/table-model.js';
import {
  assertDefinitions,
  schemaFor,
  SURFACE_DEFINITIONS,
  type SurfaceRead,
} from '../../src/surfaces/definitions.js';
import { cliDocument, workflowList } from '../support/cli-documents.js';

/** Each generated read's recorded `--json` document, by CLI command. */
const RECORDED: Readonly<Record<string, string>> = {
  'config path': 'config.path.action',
  'config list': 'config.list.action',
  'config validate': 'config.validate.action',
  'prefs list': 'prefs.list',
  profile: 'profile.defaults',
  'model list': 'model.list.action',
  'sites list': 'sites.list.action',
  'list workflows': 'list.workflows',
  'template list': 'template.list.action',
  schedules: 'schedules.empty',
  usage: 'usage.empty',
  'daemon status': 'daemon.status.action',
};

/** Reads with no recorded `--json` document yet; this list may only shrink. */
const NOT_RECORDED = ['browser list'];

const reads: readonly SurfaceRead[] = SURFACE_DEFINITIONS.flatMap((surface) => surface.reads);
const uniqueReads = [...new Map(reads.map((read) => [read.command, read])).values()];

describe('@no-llm generated table model', () => {
  it('finds the rows of the real `config path` document and makes columns its rows fill', () => {
    const document = cliDocument('config.path.action');
    const shape = tableShape(APP_READ_SCHEMAS.ConfigPathResult);
    const rows = rowsOf(document, shape);
    const columns = deriveColumns(shape, rows);

    expect(shape.rowsKey).toBe('rows');
    expect(columns.map((column) => column.label)).toEqual(['Name', 'Path', 'Source']);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const column of columns) expect(row[column.id]).not.toBeUndefined();
    }
  });

  it('never makes a column of the envelope', () => {
    const withEnvelopeColumns = uniqueReads
      .filter((read) => read.view === 'table')
      .filter((read) =>
        deriveColumns(tableShape(schemaFor(read))).some(
          (column) => column.id === 'schemaVersion' || column.id === 'kind',
        ),
      )
      .map((read) => read.command);

    expect(withEnvelopeColumns).toEqual([]);
  });

  it('reads a bare array document as its own rows', () => {
    const shape = tableShape(APP_READ_SCHEMAS.SchedulesResult);

    expect(shape.rowsKey).toBeNull();
    expect(deriveColumns(shape).map((column) => column.id)).toContain('cronExpr');
  });

  it('treats an absent optional row array as no rows', () => {
    const shape = tableShape(APP_READ_SCHEMAS.PrefsResult);

    expect(rowsOf({ schemaVersion: '0.2', kind: 'prefs', status: 'saved' }, shape)).toEqual([]);
  });

  it('shows only the union variants present in the rows', () => {
    const document = workflowList('nightly');
    const shape = tableShape(APP_READ_SCHEMAS.ListResult);

    const columns = deriveColumns(shape, rowsOf(document, shape)).map((column) => column.id);

    expect(columns).toEqual(['name', 'stepCount', 'securityClass', 'modifiedAt']);
  });

  it('refuses a document with no row array', () => {
    expect(() => tableShape(APP_READ_SCHEMAS.ConfigValidateResult as SchemaLike)).toThrow(
      TableShapeError,
    );
  });

  it('labels fields in words and keeps descriptions', () => {
    expect(humanize('totalCostUsd')).toBe('Total cost USD');
    expect(humanize('firstSeenAt')).toBe('First seen at');
    expect(humanize('workflow_name')).toBe('Workflow name');
    const source = deriveColumns(tableShape(APP_READ_SCHEMAS.ConfigPathResult)).find(
      (column) => column.id === 'source',
    );
    expect(source?.description).toMatch(/default, env:<NAME>, or config/u);
  });

  it('drops the envelope from a record and keeps a bare record whole', () => {
    expect(recordBody(cliDocument('config.validate.action'))).toEqual({
      valid: true,
      path: expect.any(String) as unknown,
    });
    const daemon = cliDocument('daemon.status.action');
    expect(recordBody(daemon)).toEqual(daemon);
  });

  it('resolves escaped JSON pointers and rejects missing ones', () => {
    expect(resolvePointer({ 'a/b': { x: 1 } }, '/a~1b/x')).toBe(1);
    expect(() => resolvePointer({}, '/x')).toThrow('Missing');
  });
});

describe('@no-llm generated surface definitions', () => {
  it('pass their own contract check', () => {
    expect(() => assertDefinitions()).not.toThrow();
  });

  it.each(uniqueReads.map((read) => [read.command, read] as const))(
    '%s matches the CLI document it reads',
    (command, read) => {
      if (NOT_RECORDED.includes(command)) return;
      // A new generated read needs a recorded --json baseline here, or an entry in NOT_RECORDED.
      const name = RECORDED[command];
      expect(name).toBeDefined();
      const document = cliDocument(name!);

      expect(schemaFor(read).safeParse(document).success).toBe(true);
      if (read.view === 'table') {
        expect(Array.isArray(rowsOf(document, tableShape(schemaFor(read))))).toBe(true);
      }
    },
  );

  it.each(
    reads.flatMap((read) =>
      (read.rowActions ?? []).map(
        (action) => [`${read.command} → ${action.command}`, read, action] as const,
      ),
    ),
  )('%s binds only fields its rows have', (_name, read, action) => {
    const ids = deriveColumns(tableShape(schemaFor(read))).map((column) => column.id);
    for (const pointer of Object.values(action.bind)) {
      expect(ids).toContain(pointer.slice(1));
    }
  });
});
