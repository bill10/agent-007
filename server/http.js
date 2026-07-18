// HTTP routes — Express static + /api/browse with origin check

import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolve } from 'path';
import { isAllowedOrigin } from './state.js';

// --- Origin Check Middleware (B2) ---
// Rejects cross-origin requests from disallowed origins. localhost is always
// allowed; add remote hostnames via ALLOWED_ORIGINS (see server/state.js).
// Requests with no Origin header are allowed through
// (covers same-origin browser requests and non-browser clients like curl).
export function checkOrigin(req, res, next) {
  if (isAllowedOrigin(req.headers.origin)) return next();
  return res.status(403).json({ error: 'Forbidden: cross-origin request' });
}

// --- Routes ---
export function setupRoutes(app, staticDir) {
  app.use(express_static(staticDir));

  app.get('/api/browse', checkOrigin, (req, res) => {
    try {
      const dirPath = req.query.path ? resolve(req.query.path) : homedir();
      if (!existsSync(dirPath)) return res.status(400).json({ error: 'Directory does not exist' });
      let resolved;
      try { resolved = realpathSync(dirPath); } catch { return res.status(400).json({ error: 'Cannot resolve path' }); }
      let stat;
      try { stat = statSync(resolved); } catch { return res.status(400).json({ error: 'Cannot read path' }); }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
      let entries;
      try {
        entries = readdirSync(resolved, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'EACCES') return res.status(403).json({ error: 'Permission denied' });
        return res.status(500).json({ error: err.message });
      }
      const showHidden = req.query.showHidden === '1';
      const dirs = entries
        .filter(e => e.isDirectory() && (showHidden || !e.name.startsWith('.')))
        .map(e => {
          const fullPath = join(resolved, e.name);
          const isGitRepo = existsSync(join(fullPath, '.git'));
          return { name: e.name, isGitRepo };
        })
        .sort((a, b) => {
          if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const parent = resolved === '/' ? null : dirname(resolved);
      const isGitRepo = existsSync(join(resolved, '.git'));
      res.json({ path: resolved, parent, isGitRepo, entries: dirs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Import express.static — passed as parameter to avoid coupling
import express from 'express';
const express_static = express.static;
