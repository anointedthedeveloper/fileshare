import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', globalSetup: ['tests/globalSetup.ts'], testTimeout: 30000, hookTimeout: 120000, include: ['tests/**/*.test.js'] },
});
