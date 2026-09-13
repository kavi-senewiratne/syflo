import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    // The Windows CI runners take several times a dev machine's wall clock
    // for the reveal-pacing suites (real timers at real reading speed) —
    // vitest's 5 s default failed a different test there each round (first
    // real matrix runs, 2026-09-13). A budget, not a target: nothing polls
    // past green. testing-library's own waitFor cap is raised in setup.ts.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
