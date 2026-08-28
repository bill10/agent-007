// HTTP routes — Express static, /api/browse, /api/jobs, /mcp, origin + auth checks

import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolve } from 'path';
import { isAllowedOrigin } from './state.js';
import {
  authEnabled, resolveToken, resolveAgentToken,
  tokenFromRequest, tokenFromAuthHeader, userById,
} from './auth.js';
import { postJobForAgent } from './jobs.js';
import { handleMcpMessage } from './mcp.js';

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
//
// Two credentials reach this server, and they are not equals:
//
//   req.user          a person, from users.json. Can do anything.
//   req.agentSession  one live agent terminal this app spawned. Can post a job
//                     to the board, and nothing else.
//
// Identity is resolved for every /api request; *authorisation* is then two
// separate gates, and the ordering in setupRoutes is what makes agent access
// opt-in. An agent token is deliberately never enough on its own for a route
// that has not been placed above the requireUser gate on purpose.

// Attach whoever is calling. Runs regardless of authEnabled(): with no users
// configured there is nothing to enforce, but an agent's token still says WHICH
// agent is calling, which is what defaults the repo and credits the card.
// Single-player is the default deployment, so identity has to work there too.
export function resolveIdentity(req, res, next) {
  const user = resolveToken(tokenFromRequest(req));
  if (user) req.user = user;
  // Header-only for the agent token — see tokenFromAuthHeader.
  const session = resolveAgentToken(tokenFromAuthHeader(req));
  if (session) req.agentSession = session;
  return next();
}

// No-op until the first user exists (keeps zero-config localhost working). Once
// users are configured, either credential gets you past this one.
export function requireIdentity(req, res, next) {
  if (!authEnabled()) return next();
  if (req.user || req.agentSession) return next();
  return res.status(401).json({ error: 'Unauthorized: valid token required' });
}

// The default gate for /api. Everything below it in setupRoutes is people-only,
// so a route added later without a thought about agents does not quietly become
// reachable by one.
//
// The two failures are different and stay different: no credential at all is
// 401 ("who are you"), while a valid agent token on a route meant for people is
// 403 ("I know who you are, and no"). Collapsing them would tell an agent to go
// and find a token when the one it has is the problem.
export function requireUser(req, res, next) {
  if (!authEnabled()) return next();
  if (req.user) return next();
  if (req.agentSession) {
    return res.status(403).json({ error: 'Forbidden: this endpoint needs a user token' });
  }
  return res.status(401).json({ error: 'Unauthorized: valid token required' });
}

// The MCP endpoint is agents only, and unlike /api it is not relaxed when auth
// is off: the token is not there to keep strangers out (it is loopback), it is
// the only thing that says which agent is calling. Without one there is no
// caller to attribute a card to, so there is nothing sensible to do.
export function requireAgent(req, res, next) {
  if (req.agentSession) return next();
  return res.status(401).json({ error: 'Unauthorized: this endpoint is for Agent 007 agent sessions' });
}

// --- Routes ---
export function setupRoutes(app, staticDir, { broadcast } = {}) {
  app.use(express_static(staticDir));

  // --- POST /mcp — the board's MCP server ---
  //
  // Mounted outside /api because it is a different audience with a different
  // credential: agents, never browsers. Origin-checked all the same, so a page
  // in the user's browser cannot reach it.
  app.post('/mcp', checkOrigin, express.json({ limit: '128kb' }), resolveIdentity, requireAgent, (req, res) => {
    const reply = handleMcpMessage(req.body, {
      session: req.agentSession,
      postJob: (fields) => postJobForAgent({ ...fields, user: userById(req.agentSession.ownerId) }, broadcast),
    });
    // A notification gets no body. 202 is what the MCP HTTP transport expects.
    if (!reply) return res.status(202).end();
    return res.json(reply);
  });

  // Gate the whole /api surface once, so new routes are origin- and auth-checked
  // by default (a per-route guard that someone forgets to add fails OPEN).
  app.use('/api', checkOrigin, resolveIdentity, express.json({ limit: '128kb' }));

  // --- Routes an agent token may reach ---
  //
  // These are ABOVE the requireUser gate, and that placement is the whole
  // access-control decision — keep it deliberate. Everything below is people
  // only.

  // The non-MCP door to the same action, for agents that cannot take an MCP
  // server (Codex and Gemini CLI both configure MCP through persistent files
  // rather than a per-invocation flag). The MCP tool is a wrapper over this
  // same function, not a second implementation.
  app.post('/api/jobs', requireIdentity, (req, res) => {
    const body = req.body || {};
    const session = req.agentSession || null;
    const result = postJobForAgent({
      title: body.title,
      detail: body.detail,
      repo: body.repo || body.repoPath,
      session,
      user: req.user || (session ? userById(session.ownerId) : null),
    }, broadcast);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(201).json(result);
  });

  // --- People only, from here down ---
  app.use('/api', requireUser);

  app.get('/api/browse', (req, res) => {
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

  // JSON errors for the JSON APIs. Without this a malformed body falls through
  // to Express's default handler, which answers an API client with an HTML
  // error page. Registered last so it only sees errors from the routes above.
  const jsonErrors = (err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err.status === 400 || err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON body' });
    console.error('API error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  };
  app.use('/api', jsonErrors);
  app.use('/mcp', jsonErrors);
}

// Import express.static — passed as parameter to avoid coupling
import express from 'express';
const express_static = express.static;
