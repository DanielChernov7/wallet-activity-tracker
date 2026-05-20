import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
