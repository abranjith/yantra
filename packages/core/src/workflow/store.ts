import { writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';

import type { WorkflowFile } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type { LintReport } from './lint/index.js';
import type { WorkflowStore, WorkflowSummary, SaveOptions } from './store.types.js';
import { emitWorkflow } from './yaml/emitter.js';
import { loadWorkflow } from './yaml/parser.js';

export class WorkflowStoreError extends Error {
  override readonly name = 'WorkflowStoreError';

  constructor(
    public readonly op: 'load' | 'save' | 'delete',
    public readonly workflowName: string,
    cause: unknown,
  ) {
    super(`Workflow store ${op} failed for "${workflowName}"`);
    this.cause = cause;
  }
}

export class WorkflowCollisionError extends Error {
  override readonly name = 'WorkflowCollisionError';

  constructor(public readonly workflowName: string) {
    super(`Workflow "${workflowName}" already exists. Pass force:true to overwrite.`);
  }
}

export class FileWorkflowStore implements WorkflowStore {
  constructor(
    private readonly workflowsDir: string,
    private readonly sidecarThreshold = 50,
  ) {}

  private filePath(name: string): string {
    return join(this.workflowsDir, `${name}.yaml`);
  }

  private tmpPath(name: string): string {
    return join(this.workflowsDir, `${name}.yaml.tmp`);
  }

  async load(name: string): Promise<Result<WorkflowFile, LintReport>> {
    try {
      return await loadWorkflow(this.filePath(name));
    } catch (e) {
      throw new WorkflowStoreError('load', name, e);
    }
  }

  async save(workflow: WorkflowFile, opts?: SaveOptions): Promise<void> {
    const name = workflow.name;
    const force = opts?.force ?? false;

    if (!force && (await this.exists(name))) {
      throw new WorkflowCollisionError(name);
    }

    const { yaml: yamlStr, sidecarJson } = emitWorkflow(workflow, {
      sidecarThreshold: this.sidecarThreshold,
    });

    const tmpPath = this.tmpPath(name);
    const finalPath = this.filePath(name);

    try {
      await writeFile(tmpPath, yamlStr, 'utf-8');
      await rename(tmpPath, finalPath);

      if (sidecarJson !== null) {
        const sidecarPath = join(this.workflowsDir, `${name}.locators.json`);
        await writeFile(sidecarPath, sidecarJson, 'utf-8');
      }
    } catch (e) {
      // Clean up tmp file on failure
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new WorkflowStoreError('save', name, e);
    }
  }

  async list(): Promise<WorkflowSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.workflowsDir);
    } catch {
      return [];
    }

    const summaries: WorkflowSummary[] = [];

    for (const entry of entries) {
      if (!entry.endsWith('.yaml')) continue;
      const name = basename(entry, '.yaml');
      const filePath = join(this.workflowsDir, entry);

      try {
        const fileStat = await stat(filePath);
        const result = await loadWorkflow(filePath);

        if (result.isOk) {
          summaries.push({
            name,
            security_class: result.value.security_class,
            step_count: result.value.steps.length,
            last_modified: fileStat.mtime,
          });
        } else {
          // Include with minimal info even if lint failed
          summaries.push({
            name,
            security_class: 'public',
            step_count: 0,
            last_modified: fileStat.mtime,
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    // Sort by last_modified descending
    summaries.sort((a, b) => b.last_modified.getTime() - a.last_modified.getTime());

    return summaries;
  }

  async delete(name: string): Promise<void> {
    try {
      await unlink(this.filePath(name));
    } catch (e) {
      throw new WorkflowStoreError('delete', name, e);
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.filePath(name));
      return true;
    } catch {
      return false;
    }
  }
}
