import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Build dist/ once before any suite runs the CLI.
    globalSetup: ['./tests/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/commands/**'],
    },
    testTimeout: 10000,
    // Keep the developer's real policy and journal out of test runs.
    env: {
      META_ADS_CLI_POLICY_FILE: '/nonexistent/meta-ads-cli-test-policy.json',
      META_ADS_CLI_NO_JOURNAL: '1',
    },
  },
});
