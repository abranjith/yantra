import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@yantra/agent',
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
  },
});
