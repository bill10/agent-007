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
  },
});
