// HTTP routes — Express static, /api/browse, /api/jobs, origin + auth checks

import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { isAllowedOrigin } from './state.js';
import { authEnabled, resolveToken, resolveAgentToken, tokenFromRequest, tokenFromAuthHeader, userById } from './auth.js';
import { addJob, resolveRepoRef, boardSettings } from './jobs.js';

// --- Origin Check Middleware (B2) ---
// Rejects cross-origin requests from disallowed origins. localhost is always
// allowed; add remote hostnames via ALLOWED_ORIGINS (see server/state.js).
// Requests with no Origin header are allowed through
// (covers same-origin browser requests and non-browser clients like curl).
export function checkOrigin(req, res, next) {
  if (isAllowedOrigin(req.headers.origin)) return next();
  return res.status(403).json({ error: 'Forbidden: cross-origin request' });
}

// --- Auth Middleware (phase 1) ---
// No-op until the first user exists (keeps zero-config localhost working). Once
// users are configured, /api requires a valid bearer token (header or ?token=).
// Attaches req.user for downstream handlers.
//
// A live agent's session token is also accepted, and attaches req.agentSession
// instead of req.user. It is a weaker credential than a user token — it says
// "one of this server's own agent terminals is calling" — so every route that
// is not meant for agents guards with requireUser. Gating both here rather than
// letting the agent route mount outside the /api gate keeps the fail-closed
// property: a new route added without thinking still gets authenticated.
export function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  // Identified before the enforcement check, and regardless of it: with no
  // users there is nothing to enforce, but an agent's token still says WHICH
  // agent is calling — which is what /api/jobs uses to default the repo and to
  // credit the card. Single-player is the default deployment, so identity has
  // to work there too.
  // Header-only for the agent token: it rides in an agent's environment, and a
  // ?token= URL would put it in every proxy log between here and nowhere.
  const session = resolveAgentToken(tokenFromAuthHeader(req));
  if (session) req.agentSession = session;
  if (!authEnabled()) return next();
  const user = resolveToken(token);
  if (user) { req.user = user; return next(); }
  if (session) return next();
  return res.status(401).json({ error: 'Unauthorized: valid token required' });
}

// For routes an agent token must not reach. No-op while auth is off, matching
// requireAuth: with no users there are no tokens to tell apart.
export function requireUser(req, res, next) {
  if (!authEnabled()) return next();
  if (req.user) return next();
  return res.status(403).json({ error: 'Forbidden: this endpoint needs a user token' });
}

// --- Routes ---
export function setupRoutes(app, staticDir, { broadcast } = {}) {
  app.use(express_static(staticDir));

  // Gate the whole /api surface once, so new routes are origin- and auth-checked
  // by default (a per-route guard that someone forgets to add fails OPEN).
  app.use('/api', checkOrigin, requireAuth, express.json({ limit: '128kb' }));

  app.get('/api/browse', requireUser, (req, res) => {
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

  // --- POST /api/jobs — post a card to the To do column ---
  //
  // The board's own UI does this over the WebSocket; this is the door for the
  // `agent-007-job` CLI, so that "add that to the job board" is something the
  // user can ask an agent they are already talking to. HTTP rather than a WS
  // message because the caller is a one-shot command, not a client that holds
  // a socket open.
  //
  // Not ownership-gated, matching the WS `job-create` handler: the board is
  // shared workspace state, and postedBy/postedByAgent are attribution rather
  // than access control.
  app.post('/api/jobs', (req, res) => {
    const body = req.body || {};
    const session = req.agentSession || null;
    // The repo the calling agent is working in is the overwhelmingly likely
    // answer, so an agent only has to name one when it means a different repo.
    const repoRef = body.repo || body.repoPath || (session && session.repoPath) || '';
    const repo = resolveRepoRef(repoRef);
    if (repo.error) return res.status(400).json({ error: repo.error });

    // Attribution: the human the agent is working for, plus the agent that
    // actually typed it. An agent spawned before auth was enabled is unowned,
    // which is fine — the agent name still says where the card came from.
    const owner = session ? userById(session.ownerId) : null;
    const user = req.user || owner;
    const result = addJob({
      // Typed explicitly: this body comes off the wire, and a non-string here
      // would be stringified into the card ("[object Object]") rather than
      // rejected. createJob still owns the length and emptiness rules.
      title: typeof body.title === 'string' ? body.title : '',
      detail: typeof body.detail === 'string' ? body.detail : '',
      repoPath: repo.path,
      postedBy: user ? user.id : null,
      postedByName: user ? user.displayName : null,
      postedByAgent: session ? session.name : null,
    }, broadcast);
    if (result.error) return res.status(400).json({ error: result.error });

    // A card an agent posted while the user was looking at a terminal would
    // otherwise land silently on a tab they cannot see. The board's own form
    // needs no toast — the user is looking straight at the column it lands in.
    if (session && broadcast) {
      broadcast({
        type: 'notification', level: 'info',
        message: `${session.name} posted a job: "${result.job.title}"`,
      });
    }
    // Whether the board will actually act on it. The CLI says so out loud: a
    // stopped dispatcher means the card sits in To do, and an agent reporting
    // "queued" without that would imply work is under way when none is.
    res.status(201).json({
      job: result.job,
      repoName: basename(repo.path),
      dispatcherRunning: !!boardSettings().running,
    });
  });

  // JSON errors for the JSON API. Without this a malformed body falls through
  // to Express's default handler, which answers an API client with an HTML
  // error page. Registered last so it only sees errors from the routes above.
  app.use('/api', (err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err.status === 400 || err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON body' });
    console.error('API error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  });
}

// Import express.static — passed as parameter to avoid coupling
import express from 'express';
const express_static = express.static;
