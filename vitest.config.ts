import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live next to the code they cover; tsconfig.json excludes them
    // from the build so nothing here can land in the published tarball.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Each file gets a fresh module registry. Several modules read env vars
    // at import time (config.ts's SUBTEXT_DEV), and the suites that exercise
    // that re-import them with vi.resetModules().
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
