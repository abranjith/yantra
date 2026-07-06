import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/core',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
    setupFiles: ['./tests/setup-jsdom.ts'],
    // Heavy @no-llm property tests (sanitizer/audit corpora, Brief inertness
    // 500-run + jsdom pass) run several seconds; the default 5s trips under
    // parallel-build CPU load. Give them headroom so the suite is not flaky.
    testTimeout: 15_000,
  },
});
