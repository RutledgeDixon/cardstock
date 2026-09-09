import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'tests'],
    // Never collect compiled output — tsc -b would otherwise emit test files into
    // dist/ and vitest would run each one twice.
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
