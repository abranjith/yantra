import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/cli',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
});
