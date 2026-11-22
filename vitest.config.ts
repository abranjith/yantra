import { defineConfig } from 'vitest/config';

/** The test projects run together from the repository root (Vitest 4 `projects`). */
export default defineConfig({
  test: {
    projects: [
      'packages/protocol',
      'packages/core',
      'packages/agent',
      'packages/test-helpers',
      'packages/ui',
      'apps/cli',
      'e2e',
    ],
  },
});
