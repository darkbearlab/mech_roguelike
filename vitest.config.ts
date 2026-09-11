import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // §1：「tests/ — core/ 全覆蓋」。門檻只套在規則層；render/ 與 ui/ 靠實機試玩。
      include: ['src/core/**/*.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 95 },
    },
  },
});
