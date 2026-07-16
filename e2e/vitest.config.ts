import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/e2e',
    environment: 'node',
    include: ['**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
    // Real-Chrome suites and CLI SQLite suites are resource-heavy on the
    // cross-package Turbo gate. Bound file concurrency so their behavioral
    // deadlines measure the code instead of host CPU starvation.
    minWorkers: 1,
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
