import type { WorkflowFile } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type { WorkflowCatalogEntry } from './catalog.js';
import type { LintReport } from './lint/index.js';

export interface WorkflowSummary {
  name: string;
  security_class: string;
  step_count: number;
  last_modified: Date;
}

export interface SaveOptions {
  force?: boolean;
}

export interface WorkflowStore {
  load(name: string): Promise<Result<WorkflowFile, LintReport>>;
  save(workflow: WorkflowFile, opts?: SaveOptions): Promise<void>;
  list(): Promise<WorkflowSummary[]>;
  /**
   * Secret-free projection of all saved workflows for agent discovery. Returns
   * only name/description/params/hosts — never secret names/values, locator
   * internals, or profile paths (FEAT-027 TASK-001).
   */
  listCatalog(): Promise<WorkflowCatalogEntry[]>;
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}
