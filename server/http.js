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
  postJobForAgent, listJobsForAgent, readJobForAgent, editJobForAgent, finishJobForAgent, closeJobForAgent, attachmentPath, allJobs, posterId,
} from './jobs.js';
import { addRepo } from './git.js';
import { expandHome } from '../lib/helpers.js';
import { requestApproval, answerApproval, readApproval } from './approvals.js';
import { mergeCheck } from './merge-check.js';
import { agentSummaries, sendMessage, sendPosterMessage, withdrawMessage, flushMessages, pendingMessages, readAgentScreen } from './messages.js';
import { handleMcpMessage } from './mcp.js';
import { notifyOwner, tellOwner, resolveQuestion, reopenQuestion, chatFilePath, roundQueue, dropQueued, roundView } from './owner.js';
import { comingRound, setRoundBrief } from './rounds.js';
import { setBillionStatus, publishStatus } from './billion-status.js';
import { availableModels } from './models.js';
import { setNextWake } from './billion-wake.js';
import { setBillionNotice } from './billion.js';
import { agentAccounts, refreshAgentAccounts } from './agent-accounts.js';
import { cliUpdates, startCliUpdate } from './cli-update.js';
import { talkSetup, voiceUtterance, voiceSays, voiceAudio, MAX_UTTERANCE_BYTES } from './talk.js';
import { updateInfo, startUpdate, updateNotes } from './self-update.js';
import { readStoreState, writeStoreState, syncSkillStore, summarize, codexBusy } from './skill-store.js';
import { busyWorkers } from './control.js';
import { noteProxy, accessEmail } from './proxy.js';
import { createRequire } from 'module';

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

// The caller's posterId (server/jobs.js), and what a message or a sent-back
// note calls it.
const callerId = (req) => posterId({ user: req.user, session: req.agentSession, anonymous: !authEnabled() });
const callerName = (req) => req.user?.displayName || req.agentSession?.name || 'an HTTP client';

const require = createRequire(import.meta.url);
const VENDOR = [
  ['vad', '@ricky0123/vad-web', ['bundle.min.js', 'vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']],
  ['ort', 'onnxruntime-web/wasm', ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']],
];

// --- Routes ---
export function setupRoutes(app, staticDir, { broadcast, killSession, respawnAgent } = {}) {
  // The tab's "N waiting" follows the queue.
  const withView = (result) => { if (result.ok) broadcast?.(roundView()); return result; };
  app.use(noteProxy);
  app.use(express_static(staticDir));
  // Talk to Billion's voice detector, served from this app, never a CDN: the
  // Silero VAD bundle, its worklet and model, and the onnxruntime-web build it runs on.
  for (const [route, file, names] of VENDOR) {
    let dir;
    try { dir = dirname(require.resolve(file)); } catch { continue; }
    app.get(`/vendor/${route}/:name`, (req, res, next) => (names.includes(req.params.name)
      ? res.sendFile(join(dir, req.params.name), { headers: { 'Cache-Control': 'public, max-age=86400' } })
      : next()));
  }

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
          : { error: 'Only Billion has a briefing queue.' }),
        dropQueued: (ref) => (req.agentSession.isBillion
          ? withView(dropQueued(ref))
          : { error: 'Only Billion has a briefing queue.' }),
        setRoundBrief: (text, which) => {
          if (!req.agentSession.isBillion) return { error: 'Only Billion writes the brief.' };
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
        tellOwner: (text, replyTo) => (req.agentSession.isBillion
          ? tellOwner(text, { broadcast, replyTo })
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
        mergeCheck: (pr) => (req.agentSession.isBillion
          ? mergeCheck(pr)
          : { error: 'Only Billion checks merges.' }),
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
      skills: body.skills,
      requiresPr: body.requiresPr ?? body.requires_pr,
      session,
      user: req.user || (session ? userById(session.ownerId) : null),
      poster: callerId(req),
    }, broadcast);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.status(201).json(result);
  });

  // The card's poster, and only it, may read the card's state here, close it,
  // and type into its worker — a headless poller with no Billion to ask
  // (README, "Job board HTTP API"). Anyone else gets 403, an unknown id 404.
  const posterCard = (req, res) => {
    const job = allJobs().find(j => j.id === req.params.id);
    if (!job) { res.status(404).json({ error: `No card with id "${req.params.id}"` }); return null; }
    const caller = callerId(req);
    if (!caller || job.postedById !== caller) {
      res.status(403).json({ error: `"${job.title}" was not posted by you.` });
      return null;
    }
    return job;
  };
  const liveWorker = (job) => {
    const worker = job.agentSessionId ? sessions.get(job.agentSessionId) : null;
    return worker && !worker.exited ? worker : null;
  };

  app.get('/api/jobs/:id', requireIdentity, (req, res) => {
    const job = posterCard(req, res);
    if (!job) return;
    return res.json({ ...readJobForAgent(job.id), workerAlive: !!liveWorker(job) });
  });

  app.post('/api/jobs/:id/close', requireIdentity, async (req, res) => {
    const body = req.body || {};
    if (typeof body.accept !== 'boolean') return res.status(400).json({ error: 'accept must be true or false' });
    try {
      const result = await closeJobForAgent({
        session: req.agentSession || null,
        poster: callerId(req),
        by: callerName(req),
        id: req.params.id,
        accept: body.accept,
        note: body.note,
      }, broadcast, { killSession });
      if (result.error) return res.status(result.forbidden ? 403 : result.notFound ? 404 : 400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      console.error('Close failed:', err);
      return res.status(500).json({ error: 'Close failed' });
    }
  });

  // Delivered as send_message delivers: queued until the worker rests at its
  // prompt, under the same length cap and pair limit. 409 when the card has no
  // live worker (To do, Done, or its terminal gone), so the poster can post a
  // new card instead.
  app.post('/api/jobs/:id/message', requireIdentity, (req, res) => {
    const job = posterCard(req, res);
    if (!job) return;
    const worker = (job.state === 'in-progress' || job.state === 'review') ? liveWorker(job) : null;
    if (!worker) return res.status(409).json({ error: 'no live worker', state: job.state });
    const result = sendPosterMessage({
      from: { id: callerId(req), name: callerName(req) },
      target: worker,
      text: req.body?.message,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    // Never the session itself: `to` carries its pty and its token.
    return res.status(202).json({ queued: result.queued || 0, delivered: !!result.delivered, id: result.id });
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

  // "Talk to Billion" (server/talk.js). The chat is the owner's alone, as
  // above. The X-Agent007-Talk header is one no form or <audio> can send, and
  // a page on another origin cannot add it without a CORS preflight this
  // server never answers, so only the tab's own fetch reaches these.
  const talkGate = (req, res, next) => {
    if (authEnabled()) return res.status(403).json({ error: 'The Billion chat is the owner\'s alone' });
    if (req.get('X-Agent007-Talk') !== '1') return res.status(403).json({ error: 'Forbidden' });
    return next();
  };
  app.get('/api/talk', talkGate, (req, res) => res.json(talkSetup()));
  // One recorded utterance (WAV), transcribed here and sent to Billion once.
  app.post('/api/talk/utterance', talkGate, express.raw({ type: 'audio/wav', limit: MAX_UTTERANCE_BYTES }), async (req, res) => {
    const result = await voiceUtterance(Buffer.isBuffer(req.body) ? req.body : null, {
      utterance: req.get('X-Utterance-Id'), echoOf: req.get('X-Echo-Of') || undefined, broadcast,
    });
    res.status(result.error ? 400 : 200).json(result);
  });
  // The browser's own transcript, when whisper.cpp is not set up.
  app.post('/api/talk/text', talkGate, async (req, res) => {
    const { utterance, text, echoOf } = req.body || {};
    const result = await voiceSays(text, { utterance, echoOf, broadcast })
      .catch(err => ({ error: `Could not send that to Billion: ${err.message}` }));
    res.status(result.error ? 400 : 200).json(result);
  });
  // One spoken piece of a voice reply.
  app.get('/api/talk/audio/:id/:index', talkGate, async (req, res) => {
    const result = await voiceAudio(req.params.id, Number(req.params.index));
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.set({ 'Content-Type': 'audio/mp4', 'X-Pieces': String(result.count), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(result.audio);
  });

  // Settings → Accounts: the last scan, or a fresh one on POST (Refresh).
  app.get('/api/agent-accounts', async (req, res) => res.json(await agentAccounts()));
  app.post('/api/agent-accounts', async (req, res) => res.json(await refreshAgentAccounts()));

  // Settings' version line and Update button (server/self-update.js). Restarting
  // the server is the owner's call, as switching the Claude account is.
  const ownerOnly = (req, res, next) => (authEnabled() ? res.status(403).json({ error: 'Only the owner can do this, and with user accounts on nobody can.' }) : next());
  // accessEmail: who Cloudflare Access let in, for the panel to show (server/proxy.js).
  app.get('/api/update', ownerOnly, async (req, res) => res.json({ ...await updateInfo({ workers: busyWorkers(sessions), fresh: req.query.fresh === '1' }), accessEmail: accessEmail(req) }));
  // What's new: the CHANGELOG sections between this version and the latest.
  app.get('/api/update/changelog', ownerOnly, async (req, res) => res.json(await updateNotes()));
  app.post('/api/update', ownerOnly, (req, res) => {
    const result = startUpdate();
    res.status(result.error ? 409 : 202).json(result);
  });
  // The agent CLIs' versions and Update, next to Agent 007's (server/cli-update.js).
  app.get('/api/cli-updates', ownerOnly, async (req, res) => res.json(await cliUpdates((await agentAccounts()).agents)));
  app.post('/api/cli-updates/:cli', ownerOnly, async (req, res) => {
    const result = startCliUpdate(req.params.cli, (await agentAccounts()).agents);
    res.status(result.error ? 409 : 202).json(result);
  });

  // Settings' One skill store (server/skill-store.js): the switch, its last
  // result, and a dry run to show before it is turned on. The owner's files.
  const storeView = (state, preview = null) => ({ ...state, summary: summarize(state.last), preview: preview && { ...preview, summary: summarize(preview) }, home: homedir() });
  const storeError = (res, err) => res.status(500).json({ error: `Skill store: ${err.message}` });
  app.get('/api/skill-store', ownerOnly, (req, res) => res.json(storeView(readStoreState())));
  app.post('/api/skill-store/preview', ownerOnly, async (req, res) => {
    try { res.json(storeView(readStoreState(), syncSkillStore({ dryRun: true, codexMoves: !await codexBusy() }))); } catch (err) { storeError(res, err); }
  });
  app.post('/api/skill-store', ownerOnly, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Send {"enabled": true} or false.' });
    try {
      const state = { ...readStoreState(), enabled: req.body.enabled };
      if (state.enabled) {
        const r = syncSkillStore({ codexMoves: !await codexBusy() });
        // Busy: on anyway, and the next agent start syncs.
        if (!r.busy) state.last = r;
      }
      writeStoreState(state);
      res.json(storeView(state));
    } catch (err) { storeError(res, err); }
  });

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
