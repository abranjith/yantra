import type { WorkflowFile } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

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
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}
