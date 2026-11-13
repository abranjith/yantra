import { defineConfig } from 'vitest/config';

import { PROCESS_SUITES } from './vitest.config.js';

/**
 * The localhost security suite and the launch-ownership evidence suite
 * (FEAT-065 merge gates): real host and worker processes, one file at a time.
 */
export default defineConfig({
  test: {
    name: '@yantra/cli:process',
    environment: 'node',
    include: PROCESS_SUITES.map((glob) => `${glob}/*.spec.ts`.replace('/**/', '/')),
    globals: false,
    fileParallelism: false,
  },
});
