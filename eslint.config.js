import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.output/**', '**/.wxt/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['apps/extension/**/*.{ts,tsx}'], ...reactHooks.configs.flat['recommended-latest'] },
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
