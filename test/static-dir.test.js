// AGENT007_STATIC_DIR: setupRoutes serves pages from the dir it is given while /api still works.
import { it, expect, afterAll } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupRoutes } from '../server/http.js';

const dir = mkdtempSync(join(tmpdir(), 'a007-custom-ui-'));
writeFileSync(join(dir, 'custom.html'), '<p>custom ui</p>');
const app = express();
setupRoutes(app, dir, { broadcast: () => {} });
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
afterAll(() => server.close());

it('serves a page from the custom dir and keeps /api routes', async () => {
  expect(await (await fetch(`${base}/custom.html`)).text()).toBe('<p>custom ui</p>');
  const api = await fetch(`${base}/api/browse?path=${encodeURIComponent(dir)}`);
  expect(api.status).toBe(200);
});
