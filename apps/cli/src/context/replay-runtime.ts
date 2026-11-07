import type { RunOrchestrator, loadResumePoint } from '@yantra/core/workflow/replay';

import type { recordTaskHistory } from '../history.js';
import type { buildOrchestratorRuntime } from '../runtime.js';

/** Replay's application ports; adapters share production defaults and tests inject external engines. */
export interface ReplayRuntimeDependencies {
  readonly build?: (options: Parameters<typeof buildOrchestratorRuntime>[0]) => Promise<{
    readonly orchestrator: Pick<RunOrchestrator, 'run' | 'resume'>;
    readonly close: () => void;
  }>;
  readonly loadResumePoint?: typeof loadResumePoint;
  readonly recordHistory?: typeof recordTaskHistory;
}
