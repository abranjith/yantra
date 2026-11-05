import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/ui',
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // Tailwind runs only in the gallery build; unit tests assert on class
    // names and DOM semantics, never on computed CSS.
    css: false,
    // The boundary spec lints real files through the ESLint API, which loads
    // the type-aware program on first use.
    testTimeout: 15_000,
  },
});
