import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/protocol',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
});
