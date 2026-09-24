import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.output/**', '**/.wxt/**'] },
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
