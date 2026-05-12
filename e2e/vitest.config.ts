import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/e2e',
    environment: 'node',
    include: ['**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    globals: false,
  },
});
