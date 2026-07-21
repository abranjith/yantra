import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/test-helpers',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
});
