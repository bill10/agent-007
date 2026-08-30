import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    setupFiles: ['./test/setup.js'],
    // node-pty ships a native .node addon. Vite must not try to transform it,
    // which it does on Windows when it inlines the package (server.js ->
    // server/pty.js -> node-pty fails with "Invalid or unexpected token").
    server: { deps: { external: [/node-pty/] } },
  },
});
