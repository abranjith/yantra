import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/core',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
    setupFiles: ['./tests/setup-jsdom.ts'],
  },
});
