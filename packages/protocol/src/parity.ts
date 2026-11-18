/** Browser-safe registry values used by the app's parity manifest. */
export { RUN_EVENT_KINDS, type RunEventKind } from './schemas/run-event.js';
export {
  RUN_ARTIFACT_REGISTRY,
  type RunArtifactRegistryEntry,
  type RunArtifactViewer,
} from './schemas/run-artifacts.js';
import { CLI_READ_OUTPUT_SCHEMAS } from './schemas/cli-read-outputs.js';
import { ListResult } from './schemas/cli-reads.js';

export { CLI_READ_OUTPUT_SCHEMAS };
export const APP_READ_SCHEMAS = { ...CLI_READ_OUTPUT_SCHEMAS, ListResult } as const;
