import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'fixtures/**', 'packages/app/public/__smoke.js', 'packages/app/src-tauri/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.es2023 } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // The architecture check in tools/check-boundaries.mjs enforces package layering;
      // this catches the same class of mistake within a package.
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['../../*'], message: 'Reach across packages via @cardstock/*, not relative paths.' }],
      }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['tools/**/*.mjs', '**/*.config.ts', '**/*.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Runs in the browser console against the live app, not in Node.
    files: ['tools/browser-smoke.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
