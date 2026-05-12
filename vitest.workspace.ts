import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/protocol',
  'packages/core',
  'packages/agent',
  'packages/test-helpers',
  'apps/cli',
  'e2e',
]);
