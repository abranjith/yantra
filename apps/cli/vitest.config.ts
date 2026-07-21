import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/cli',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
});
