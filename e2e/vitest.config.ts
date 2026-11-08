import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/e2e',
    environment: 'node',
    include: ['**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
    // Repository-wide typed lint and real-Chrome scenarios are each resource-heavy.
    // Run files serially so lint cannot starve a browser scenario of memory or CPU;
    // each scenario retains its own behavioral deadline.
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
