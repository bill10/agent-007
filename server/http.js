// HTTP routes — Express static, /api/browse, /api/jobs, /mcp, origin + auth checks

import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolve } from 'path';
import { isAllowedOrigin, sessions } from './state.js';
import {
  authEnabled, resolveToken, resolveAgentToken,
  tokenFromRequest, tokenFromAuthHeader, userById,
} from './auth.js';
import {
  postJobForAgent, listJobsForAgent, readJobForAgent, editJobForAgent, finishJobForAgent, closeJobForAgent, retireJobForAgent, reconcileJobForAgent, attachmentPath, allJobs,
} from './jobs.js';
import { addRepo } from './git.js';
import { expandHome } from '../lib/helpers.js';
import { requestApproval, answerApproval, readApproval } from './approvals.js';
import { agentSummaries, sendMessage, withdrawMessage, flushMessages, pendingMessages, readAgentScreen } from './messages.js';
import { handleMcpMessage } from './mcp.js';
import { notifyOwner, tellOwner, resolveQuestion, reopenQuestion, chatFilePath, roundQueue, dropQueued, roundView } from './owner.js';
import { comingRound, setRoundBrief } from './rounds.js';
import { setBillionStatus, publishStatus } from './billion-status.js';
import { availableModels } from './models.js';
import { setNextWake } from './billion-wake.js';
import { setBillionNotice } from './billion.js';
import { agentAccounts, refreshAgentAccounts } from './agent-accounts.js';

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
//                     to the board, read the board back, and edit a To do card
//                     its own owner queued — and nothing else.
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
export function setupRoutes(app, staticDir, { broadcast, killSession, respawnAgent } = {}) {
  // The tab's "N waiting" follows the queue.
  const withView = (result) => { if (result.ok) broadcast?.(roundView()); return result; };
  app.use(express_static(staticDir));

  // --- POST /mcp — the board's MCP server ---
  //
  // Mounted outside /api because it is a different audience with a different
  // credential: agents, never browsers. Origin-checked all the same, so a page
  // in the user's browser cannot reach it.
  // Async because finish_job waits on a PR lookup. Express 4 does not catch a
  // rejected handler, so the catch below is what keeps a throw from hanging it.
  app.post('/mcp', checkOrigin, express.json({ limit: '128kb' }), resolveIdentity, requireAgent, async (req, res) => {
    let reply;
    try {
      reply = await handleMcpMessage(req.body, {
        session: req.agentSession,
        models: availableModels(),
        postJob: (fields) => postJobForAgent({ ...fields, user: userById(req.agentSession.ownerId) }, broadcast),
        listJobs: listJobsForAgent,
        readJob: readJobForAgent,
        // The session and its owner, like postJob: an edit is refused on another
        // person's card and stamped with the agent's name when it lands.
        editJob: (fields) => editJobForAgent({
          ...fields,
          session: req.agentSession,
          user: userById(req.agentSession.ownerId),
        }, broadcast),
        listAgents: () => agentSummaries(req.agentSession, sessions,
          (jobId) => allJobs().find(job => job.id === jobId)?.title),
        sendMessage: ({ to, text, replaces }) => sendMessage({ from: req.agentSession, to, text, replaces, sessions }),
        withdrawMessage: (id) => withdrawMessage({ from: req.agentSession, id, sessions }),
        finishJob: (fields) => finishJobForAgent({ ...fields, session: req.agentSession }, broadcast),
        // Billion's own tools: toolsFor() lists them only for its session, and
        // each checks again here.
        addRepo: async (path) => {
          if (!req.agentSession.isBillion) return { error: 'Only Billion can add repositories.' };
          return addRepo(expandHome(path), broadcast);
        },
        closeJob: (fields) => closeJobForAgent({ ...fields, session: req.agentSession }, broadcast, { killSession }),
        reconcileJob: (fields) => reconcileJobForAgent({ ...fields, session: req.agentSession }, broadcast),
        retireJob: (fields) => retireJobForAgent({ ...fields, session: req.agentSession }, broadcast),
        answerPermission: ({ id, decision, reason }) => (req.agentSession.isBillion
          ? answerApproval(id, decision, reason)
          : { error: 'Only Billion answers permission requests.' }),
        readApproval: (id) => (req.agentSession.isBillion
          ? readApproval(id)
          : { error: 'Only Billion can read approval requests.' }),
        notifyOwner: async (text, { choices, recommended, urgency, project, type, telegram, rank } = {}) => (req.agentSession.isBillion
          ? { ...await notifyOwner(text, { choices, recommended, urgency, project, type, telegram, rank, broadcast }), nextRound: comingRound() }
          : { error: 'Only Billion can notify the owner.' }),
        listRoundQueue: () => (req.agentSession.isBillion
          ? { ...roundQueue(), nextRound: comingRound() }
          : { error: 'Only Billion has a round queue.' }),
        dropQueued: (ref) => (req.agentSession.isBillion
          ? withView(dropQueued(ref))
          : { error: 'Only Billion has a round queue.' }),
        setRoundBrief: (text, which) => {
          if (!req.agentSession.isBillion) return { error: 'Only Billion writes the round brief.' };
          const result = setRoundBrief(text, which);
          if (result.ok && which === 'current') broadcast(roundView());
          return result;
        },
        setStatus: (text) => {
          if (!req.agentSession.isBillion) return { error: 'Only Billion has a status line.' };
          const result = setBillionStatus(text);
          if (result.ok) publishStatus(broadcast);
          return result;
        },
        tellOwner: (text) => (req.agentSession.isBillion
          ? tellOwner(text, { broadcast })
          : { error: 'Only Billion can message the owner.' }),
        resolveQuestion: (ref, answer) => (req.agentSession.isBillion
          ? resolveQuestion(ref, answer, { broadcast })
          : { error: 'Only Billion can resolve the owner\'s questions.' }),
        reopenQuestion: (ref) => (req.agentSession.isBillion
          ? reopenQuestion(ref, { broadcast })
          : { error: 'Only Billion can reopen the owner\'s questions.' }),
        // Never logged: a screen can hold a secret that scrolled by.
        readAgentScreen: ({ name, lines }) => readAgentScreen({
          from: req.agentSession, name, lines, sessions,
          isBillionCard: (jobId) => allJobs().some(job => job.id === jobId && job.postedByBillion),
        }),
        respawnAgent: ({ name }) => (respawnAgent
          ? respawnAgent(req.agentSession, name)
          : { error: 'Re-spawning is not available.' }),
        setNextWake: (minutes) => (req.agentSession.isBillion
          ? setNextWake(req.agentSession, minutes)
          : { error: 'Only Billion has an operating loop.' }),
        billionReady: () => {
          const session = req.agentSession;
          if (!session.isBillion) return { error: 'Only Billion has an inbox to open.' };
          session.messagesHeld = false;
          setBillionNotice(session, null, broadcast);
          flushMessages(session);
          return { waiting: pendingMessages(session.id) };
        },
      });
    } catch (err) {
      console.error('MCP call failed:', err);
      return res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'Internal error' } });   // 200, as JSON-RPC errors are: the Codex bridge drops a non-2xx body. Detail stays in the log.
    }
    // A notification gets no body. 202 is what the MCP HTTP transport expects.
    if (!reply) return res.status(202).end();
    return res.json(reply);
  });

  // A worker's PermissionRequest hook (server/permission-hook.js), with that
  // worker's own agent token. Answers with the hook's output: Billion's
  // decision, or {} for none — which is also what anything unexpected gets,
  // so the dialog falls back to a person.
  app.post('/hook/permission', checkOrigin, express.json({ limit: '256kb' }), resolveIdentity, requireAgent, async (req, res) => {
    try {
      const worker = req.agentSession;
      const jobTitle = worker.jobId ? allJobs().find(job => job.id === worker.jobId)?.title : null;
      res.json(await requestApproval(worker, req.body, { jobTitle }));
    } catch (err) {
      console.error('Permission hook failed:', err);
      res.json({});
    }
  });

  // Gate the whole /api surface once, so new routes are origin- and auth-checked
  // by default (a per-route guard that someone forgets to add fails OPEN).
  app.use('/api', checkOrigin, resolveIdentity, express.json({ limit: '128kb' }));

  // --- Routes an agent token may reach ---
  //
  // These are ABOVE the requireUser gate, and that placement is the whole
  // access-control decision — keep it deliberate. Everything below is people
  // only.

  // The non-MCP door to the same action, available to clients with an agent
  // session token. MCP calls share this implementation through postJobForAgent.
  app.post('/api/jobs', requireIdentity, (req, res) => {
    const body = req.body || {};
    const session = req.agentSession || null;
    const result = postJobForAgent({
      title: body.title,
      detail: body.detail,
      repo: body.repo || body.repoPath,
      type: body.type,
      schedule: body.schedule,
      once: body.once,
      runAt: body.runAt ?? body.run_at,
      agent: body.agent,
      model: body.model,
      requiresPr: body.requiresPr ?? body.requires_pr,
      session,
      user: req.user || (session ? userById(session.ownerId) : null),
    }, broadcast);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(201).json(result);
  });

  // --- People only, from here down ---
  app.use('/api', requireUser);

  // A card's attached file, for the link on the card. Served sandboxed: an
  // uploaded HTML file must not run as this origin, where the token lives.
  // The link carries the token in its query, so no-referrer keeps a page
  // that loads an outside image from handing that URL on (sandbox alone does
  // not stop subresource loads or a <meta name=referrer>). dotfiles: 'allow'
  // is load-bearing: with no root, send checks EVERY segment of the absolute
  // path for a leading dot, and the default config dir is ~/.agent-007 — the
  // default 'ignore' would 404 every attachment in production (the test
  // config dir has no dot segment, so the suite cannot catch that). It also
  // lets a ".env" attachment through.
  app.get('/api/jobs/:id/attachments/:name', (req, res) => {
    const path = attachmentPath(req.params.id, req.params.name);
    if (!path) return res.status(404).json({ error: 'No such attachment' });
    res.sendFile(resolve(path), {
      dotfiles: 'allow',
      headers: {
        'Content-Security-Policy': 'sandbox',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Attachment missing on disk' }); });
  });

  // A file the owner attached in the Billion tab, for the thumbnail and the
  // link in their bubble. The chat is the owner's alone (ws.js mayAnswerOwner):
  // with user accounts on nobody has it, so nobody gets its files either.
  // Served like a card's attachment, for the same reasons.
  app.get('/api/chat/:id/files/:name', (req, res) => {
    if (authEnabled()) return res.status(403).json({ error: 'The Billion chat is the owner\'s alone' });
    const path = chatFilePath(req.params.id, req.params.name);
    if (!path) return res.status(404).json({ error: 'No such file' });
    res.sendFile(path, {
      dotfiles: 'allow',
      headers: {
        'Content-Security-Policy': 'sandbox',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'File missing on disk' }); });
  });

  // The Settings panel's "Agents & accounts": the last scan, or a fresh one on POST (Refresh).
  app.get('/api/agent-accounts', async (req, res) => res.json(await agentAccounts()));
  app.post('/api/agent-accounts', async (req, res) => res.json(await refreshAgentAccounts()));

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
      // dirname() of a root is that same root ('/' on POSIX, 'C:\' on Windows),
      // so compare instead of hard-coding '/': the Windows drive root would
      // otherwise offer an "up" link that navigates to itself forever.
      const parentDir = dirname(resolved);
      const parent = parentDir === resolved ? null : parentDir;
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
