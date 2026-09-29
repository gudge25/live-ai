import { defineConfig } from 'vitest/config';

/** Shared across packages/shared, apps/server, and apps/extension. */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
