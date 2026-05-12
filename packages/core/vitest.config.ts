import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/core',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
});
