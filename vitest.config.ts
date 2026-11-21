import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['src/__tests__/offline-setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    // Each test file resets process.env via vi.stubEnv — make sure restores
    // run between files so a leaked stub from one file doesn't poison the next.
    unstubEnvs: true,
  },
});
