import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/protocol',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
    // Heavy @no-llm property/doc-emit tests (e.g. the full spec-doc emitter)
    // run several seconds; the default 5s trips under parallel-build CPU load.
    testTimeout: 15_000,
  },
});
