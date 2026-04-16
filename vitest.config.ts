import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'src/internal/bidding/**',
        'src/internal/idempotency/**',
        'src/internal/settlement/**',
        'src/internal/ratelimit/**',
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
