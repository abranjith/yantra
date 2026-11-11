import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/web',
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // Tailwind runs only in the Vite build; tests assert on DOM and behavior.
    css: false,
    testTimeout: 15_000,
  },
});
