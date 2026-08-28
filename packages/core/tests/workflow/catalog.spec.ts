// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { WorkflowCatalogEntry, projectCatalogEntry } from '../../src/workflow/catalog.js';
import { FileWorkflowStore } from '../../src/workflow/store.js';

function makeWorkflow(name: string, overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    name,
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: [],
    cookies: 'none',
    steps: [{ id: 's1', verb: 'navigate', url: 'https://example.com', scope: null }],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
    ...overrides,
  };
}

describe('projectCatalogEntry', () => {
  it('never leaks secret identifiers into the serialized catalog', () => {
    // Arrange — a workflow that uses a canary-named secret and a locator whose
    // internals should never reach the model.
    const workflow = makeWorkflow('login-flow', {
      description: 'Sign in and download the statement',
      secrets: ['bank.CANARY_SECRET_KEY'],
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://bank.example.com/login', scope: null },
        {
          id: 's2',
          verb: 'fill',
          locator: 'pw',
          value: null,
          submit: true,
          scope: null,
          requires_confirmation: false,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
        },
      ],
      _locators: { pw: [{ kind: 'css', value: '#CANARY_SELECTOR_INTERNAL' }] },
    });

    // Act
    const entry = projectCatalogEntry(workflow);
    const serialized = JSON.stringify(entry);

    // Assert — no secret name, no locator internal, anywhere in the output.
    expect(serialized).not.toContain('CANARY_SECRET_KEY');
    expect(serialized).not.toContain('CANARY_SELECTOR_INTERNAL');
    expect(entry).not.toHaveProperty('secrets');
    expect(entry).not.toHaveProperty('_locators');
    expect(entry).not.toHaveProperty('cookies');
  });

  it('derives params (name/type/required) from declarations', () => {
    const workflow = makeWorkflow('with-params', {
      params: {
        month: { type: 'string', required: true, example: '2026-04' },
        limit: { type: 'number', required: false, example: null },
      },
    });

    const entry = projectCatalogEntry(workflow);

    expect(entry.params).toEqual([
      { name: 'month', type: 'string', required: true },
      { name: 'limit', type: 'number', required: false },
    ]);
    // The declaration's example value is dropped from the projection.
    expect(JSON.stringify(entry)).not.toContain('2026-04');
  });

  it('derives distinct sorted hosts from literal navigate URLs', () => {
    const workflow = makeWorkflow('multi-host', {
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://z.example.com/a', scope: null },
        { id: 's2', verb: 'navigate', url: 'https://a.example.com/b', scope: null },
        { id: 's3', verb: 'navigate', url: 'https://z.example.com/c', scope: null },
      ],
    });

    const entry = projectCatalogEntry(workflow);

    expect(entry.hosts).toEqual(['a.example.com', 'z.example.com']);
  });

  it('omits template navigate URLs that cannot be resolved statically', () => {
    const workflow = makeWorkflow('templated', {
      steps: [
        { id: 's1', verb: 'navigate', url: 'https://real.example.com/x', scope: null },
        { id: 's2', verb: 'navigate', url: '{{ params.target }}', scope: null },
      ],
    });

    const entry = projectCatalogEntry(workflow);

    expect(entry.hosts).toEqual(['real.example.com']);
    expect(JSON.stringify(entry)).not.toContain('params.target');
  });

  it('projects a null description to an empty string', () => {
    const entry = projectCatalogEntry(makeWorkflow('nodesc', { description: null }));
    expect(entry.description).toBe('');
  });

  it('validates against the closed WorkflowCatalogEntry schema', () => {
    const entry = projectCatalogEntry(
      makeWorkflow('valid', {
        description: 'ok',
        params: { a: { type: 'boolean', required: true, example: null } },
      }),
    );
    // The strict schema rejects any extra field, so a clean parse proves the
    // projection contains only the four allowed keys.
    expect(() => WorkflowCatalogEntry.parse(entry)).not.toThrow();
    expect(() => WorkflowCatalogEntry.parse({ ...entry, secrets: ['x.y'] })).toThrow();
  });
});

describe('FileWorkflowStore.listCatalog', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yantra-catalog-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty list for an empty store', async () => {
    const store = new FileWorkflowStore(tmpDir);
    await expect(store.listCatalog()).resolves.toEqual([]);
  });

  it('returns catalog entries sorted by name', async () => {
    const store = new FileWorkflowStore(tmpDir);
    await store.save(makeWorkflow('zeta', { description: 'Z workflow' }));
    await store.save(makeWorkflow('alpha', { description: 'A workflow' }));

    const catalog = await store.listCatalog();

    expect(catalog.map((e) => e.name)).toEqual(['alpha', 'zeta']);
    expect(catalog[0]?.description).toBe('A workflow');
  });
});
