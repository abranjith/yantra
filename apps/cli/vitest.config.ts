import { defineConfig } from 'vitest/config';

/**
 * Suites that start real host and worker processes run separately, one file
 * at a time (`vitest.process.config.ts`): under the parallel run they compete
 * for the CPU and miss real readiness deadlines.
 */
export const PROCESS_SUITES = ['tests/ui/security/**', 'tests/ui/launch-ownership/**'];

export default defineConfig({
  test: {
    name: '@yantra/cli',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', ...PROCESS_SUITES],
    globals: false,
  },
});
