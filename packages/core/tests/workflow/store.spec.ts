// @no-llm
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkflowFile } from '@yantra/protocol';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { FileWorkflowStore, WorkflowCollisionError } from '../../src/workflow/store.js';

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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yantra-store-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('FileWorkflowStore', () => {
  describe('save() and load()', () => {
    it('saves a workflow and loads it back', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('my-workflow');

      await store.save(workflow);
      const result = await store.load('my-workflow');

      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value.name).toBe('my-workflow');
      }
    });

    it('throws WorkflowCollisionError if workflow exists and force is not set', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('my-workflow');

      await store.save(workflow);

      await expect(store.save(workflow)).rejects.toBeInstanceOf(WorkflowCollisionError);
    });

    it('overwrites when force:true', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('my-workflow', { description: 'First' });

      await store.save(workflow);
      const updated = makeWorkflow('my-workflow', { description: 'Second' });
      await store.save(updated, { force: true });

      const result = await store.load('my-workflow');
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value.description).toBe('Second');
      }
    });

    it('performs an atomic save (no partial .tmp files left after success)', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('atomic-test');

      await store.save(workflow);

      // No .tmp file should remain
      await expect(stat(join(tmpDir, 'atomic-test.yaml.tmp'))).rejects.toThrow();

      // The actual file should exist
      await expect(stat(join(tmpDir, 'atomic-test.yaml'))).resolves.toBeDefined();
    });
  });

  describe('exists()', () => {
    it('returns false when workflow does not exist', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const exists = await store.exists('nonexistent');
      expect(exists).toBe(false);
    });

    it('returns true when workflow exists', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('existing');

      await store.save(workflow);
      const exists = await store.exists('existing');
      expect(exists).toBe(true);
    });
  });

  describe('delete()', () => {
    it('deletes an existing workflow', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('to-delete');

      await store.save(workflow);
      await store.delete('to-delete');

      const exists = await store.exists('to-delete');
      expect(exists).toBe(false);
    });

    it('throws when deleting a non-existent workflow', async () => {
      const store = new FileWorkflowStore(tmpDir);
      await expect(store.delete('nonexistent')).rejects.toThrow();
    });
  });

  describe('list()', () => {
    it('returns empty array when directory is empty', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const list = await store.list();
      expect(list).toHaveLength(0);
    });

    it('returns saved workflows', async () => {
      const store = new FileWorkflowStore(tmpDir);

      await store.save(makeWorkflow('workflow-a'));
      await store.save(makeWorkflow('workflow-b'));

      const list = await store.list();
      expect(list.length).toBe(2);
      const names = list.map((s) => s.name);
      expect(names).toContain('workflow-a');
      expect(names).toContain('workflow-b');
    });

    it('includes step_count in summary', async () => {
      const store = new FileWorkflowStore(tmpDir);
      const workflow = makeWorkflow('counted', {
        steps: [
          { id: 's1', verb: 'navigate', url: 'https://example.com', scope: null },
          { id: 's2', verb: 'click', locator: 'Button', scope: null },
        ],
        _locators: { Button: [{ kind: 'role', role: 'button', name: 'Button' }] },
      });
      await store.save(workflow);

      const list = await store.list();
      const summary = list.find((s) => s.name === 'counted');
      expect(summary).toBeDefined();
      expect(summary?.step_count).toBe(2);
    });

    it('orders results by last_modified descending', async () => {
      const store = new FileWorkflowStore(tmpDir);

      await store.save(makeWorkflow('first'));
      // Small delay to ensure different mtime
      await new Promise((r) => setTimeout(r, 10));
      await store.save(makeWorkflow('second'));

      const list = await store.list();
      // Most recently modified first
      expect(list[0]?.name).toBe('second');
      expect(list[1]?.name).toBe('first');
    });
  });
});
