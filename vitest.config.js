import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    setupFiles: ['./test/setup.js'],
    // node-pty ships a native .node addon that Vite must never transform.
    // Keeping it external is what lets test/server.test.js (server.js ->
    // server/pty.js -> node-pty) load on Windows instead of dying at
    // collection with "Invalid or unexpected token".
    server: { deps: { external: ['node-pty'] } },
    // Windows CI runners are ~2x slower and their git ops slower still: the
    // worktree suites' git-heavy tests run 5-12s there vs <5s elsewhere.
    ...(process.platform === 'win32' && { testTimeout: 30000, hookTimeout: 30000 }),
  },
});
