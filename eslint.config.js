// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import vitestPlugin from 'eslint-plugin-vitest';
import prettierConfig from 'eslint-config-prettier';

const AGENT_BOUNDARY_MESSAGE =
  '@yantra/agent must not import from @yantra/core (architectural boundary, see CLAUDE.md / plan §7)';
const PI_AGENT_CORE_BOUNDARY_MESSAGE =
  'Direct pi-agent-core imports are forbidden outside packages/agent. Use the LLMClient interface.';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/_lint-fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-default-export': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always',
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },

  // Vitest plugin for spec files.
  {
    files: ['**/*.spec.ts'],
    plugins: { vitest: vitestPlugin },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
    },
  },

  // Trust-boundary packages: no `any`, even with a comment.
  {
    files: ['packages/protocol/**/*.ts', 'packages/agent/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Architectural boundary 1: packages/agent cannot import @yantra/core.
  {
    files: ['packages/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@yantra/core', '@yantra/core/*', '**/packages/core/**'],
              message: AGENT_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Architectural boundary 2: direct pi-agent-core imports forbidden outside packages/agent.
  {
    files: [
      'packages/protocol/**/*.ts',
      'packages/core/**/*.ts',
      'packages/test-helpers/**/*.ts',
      'apps/**/*.ts',
      'e2e/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pi-agent-core', 'pi-agent-core/*'],
              message: PI_AGENT_CORE_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // Lint fixture files: they intentionally violate boundaries.
  // Excluded from build configs and only loaded by the boundary spec.
  {
    files: ['**/_lint-fixtures/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // CLI entrypoint may use console.log.
  {
    files: ['apps/cli/src/index.ts', 'apps/cli/src/bin.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Config files: turn off type-checked rules; they aren't part of a TS project.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.config.{js,cjs,mjs,ts}', '**/*.config.*.{js,cjs,mjs,ts}', 'scripts/**/*.{js,mjs,ts}'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'import/order': 'off',
    },
  },

  {
    ...tseslint.configs.disableTypeChecked,
    files: ['eslint.config.js', 'vitest.workspace.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'import/no-default-export': 'off',
      'import/order': 'off',
    },
  },

  // Protocol scripts/tests/generated files are outside package tsconfig project includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      'packages/protocol/generated/**/*.ts',
      'packages/protocol/scripts/**/*.ts',
      'packages/protocol/tests/**/*.ts',
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  // Agent tests are outside the package tsconfig project includes.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['packages/agent/tests/**/*.ts'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
    },
  },

  prettierConfig,
);
