// Voice input — dictate into the active terminal via the Web Speech API.
// Finalized speech is sent as pty-input (exactly like typing); nothing is
// auto-submitted — the user still presses Enter to send the prompt. Note that
// transcripts are keystrokes: a raw-mode program at the prompt (a pager, a
// y/n confirmation) reacts to them like typing, so the mic is deliberately
// bounded — it stops on silence, on session switch or end, on a hidden tab,
// and at an absolute session cap.
import { agents, activeSessionId, canControlAgent } from './state.js';
import { send } from './ws.js';

const LISTENING_LABEL = 'Listening…';
const FLASH_HIDE_MS = 4000;
const RESTART_DELAY_MS = 250;
// Browsers end a recognition session after a few seconds of silence and we
// restart it. 8 consecutive sessions with no *delivered* speech ≈ a minute of
// silence (or ~2s of abort ping-pong with another tab using the mic) — stop
// instead of keeping a hot mic forever. Ambient noise can still produce
// results, so an absolute wall-clock cap backs this up.
const SILENT_RESTART_LIMIT = 8;
const SESSION_MAX_MS = 5 * 60 * 1000;
// The indicator pill shows the tail of the interim transcript — the words
// being spoken now — not the head.
const INTERIM_TAIL_CHARS = 80;

// User intent: mic toggled on. The browser stops recognition on its own after
// silence, so onend restarts it while this stays true.
let listening = false;
let recognition = null;
let silentRestarts = 0;
let sessionStart = 0;
let flashTimer = null;
// Bumped on every toggle-on; async permission callbacks compare against it so
// a stop → quick re-toggle can't leave two recognition sessions running.
let voiceGen = 0;
// True after getUserMedia has succeeded once: later toggles skip the prime
// (each acquire/release cycle costs 100-500ms of dead latency before speech).
// Invalidated when recognition hits a permission/hardware error so a revoked
// mic re-enters the honest getUserMedia-first flow instead of fast-pathing
// into recording signals that instantly die.
let micPrimed = false;
// True once beginListening() turned the recording signals on — gates the
// "Voice input stopped" announcement so a cancelled permission phase doesn't
// announce a stop for a session that never started.
let signalsOn = false;

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Collapse whitespace and separate consecutive utterances with a space.
// Exported for tests.
export function normalizeTranscript(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t ? t + ' ' : '';
}

// --- Pure recognition-event logic, exported for tests. The Speech API event
// handlers below stay thin shells over these so the mic's safety bookkeeping
// (silence budget, session cap, error mapping) is unit-testable in node. ---

// Split one recognition result batch into normalized finalized chunks and the
// concatenated interim text.
export function collectResults(results, startIndex) {
  const finals = [];
  let interim = '';
  for (let i = startIndex; i < results.length; i++) {
    const result = results[i];
    if (result.isFinal) {
      const text = normalizeTranscript(result[0].transcript);
      if (text) finals.push(text);
    } else {
      interim += result[0].transcript;
    }
  }
  return { finals, interim };
}

// The indicator pill shows the words being spoken NOW — the tail, not the head.
export function interimTail(interim) {
  return interim.length > INTERIM_TAIL_CHARS ? '…' + interim.slice(-INTERIM_TAIL_CHARS) : interim;
}

// Map a SpeechRecognition error code to a user-facing message, or null for
// codes that are part of normal operation (silence timeouts, our own abort()).
export function recognitionErrorMessage(code) {
  if (code === 'no-speech' || code === 'aborted') return null;
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'Microphone access denied — allow it in your browser settings';
  }
  if (code === 'audio-capture') return 'No microphone found';
  return `Voice input error: ${code}`;
}

// Decide what a recognition end means: give up after the silence budget is
// spent ('pause'), enforce the absolute session cap ('expire'), else 'restart'.
export function onEndAction(restarts, elapsedMs) {
  if (restarts >= SILENT_RESTART_LIMIT) return 'pause';
  if (elapsedMs > SESSION_MAX_MS) return 'expire';
  return 'restart';
}

// Map a getUserMedia rejection name to actionable guidance. Only permission
// errors should point at browser settings — a mic held by another app or
// missing hardware needs different advice.
export function mediaErrorMessage(name) {
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone found';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Microphone is in use by another app';
  if (name === 'AbortError') return 'Microphone could not start — try again';
  if (name === 'SecurityError') return 'Microphone blocked by browser or system policy';
  return 'Microphone access denied — allow it in your browser settings, then click the mic again';
}

function micBtn() { return document.getElementById('btn-voice'); }

// Screen-reader announcements go to an always-rendered visually-hidden live
// region — the visual pill toggles display:none, which most screen readers
// won't announce, and per-interim rewrites would be announcement spam anyway.
// Only discrete transitions (started / stopped / errors) are announced.
function announce(text) {
  const el = document.getElementById('voice-status');
  if (el) el.textContent = text;
}

// Indicator pill: cached element + last-rendered state so per-interim-result
// updates skip redundant style/layout work. kind: 'live' shows the recording
// dot; 'notice' and 'error' hide it (the mic is off — a pulsing red dot would
// be an inverted privacy signal).
let indicatorEl = null;
let indicatorLast = null;

function indicator() {
  if (!indicatorEl) indicatorEl = document.getElementById('voice-indicator');
  return indicatorEl;
}

function showIndicator(text, kind = 'live') {
  const el = indicator();
  if (!el) return;
  const key = `${kind}:${text}`;
  if (key === indicatorLast) return;
  indicatorLast = key;
  el.querySelector('.voice-indicator-text').textContent = text;
  el.classList.toggle('error', kind === 'error');
  el.classList.toggle('notice', kind === 'notice');
  el.style.display = 'flex';
}

function hideIndicator() {
  const el = indicator();
  if (!el) return;
  indicatorLast = null;
  el.style.display = 'none';
}

// Flash a transient message in the pill, then hide it unless dictation runs.
function flashIndicator(text, kind) {
  showIndicator(text, kind);
  announce(text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!listening) hideIndicator(); }, FLASH_HIDE_MS);
}

function showError(text) { flashIndicator(text, 'error'); }

// Send one finalized transcript chunk to the active pty. Returns false when
// it cannot be delivered (no session, ended session, view-only, socket down)
// so the caller can stop instead of silently losing speech. The DISCONNECTED
// check mirrors the server's exited-session drop — without it a dead pty
// looks deliverable from the client. Exported for tests.
export function deliverToActivePty(text) {
  if (!activeSessionId) return false;
  const agent = agents.get(activeSessionId);
  if (!agent || agent.state === 'DISCONNECTED' || !canControlAgent(agent)) return false;
  return send({ type: 'pty-input', sessionId: activeSessionId, data: text });
}

function sessionExpired() {
  return Date.now() - sessionStart > SESSION_MAX_MS;
}

function startRecognition() {
  const Ctor = recognitionCtor();
  // Recreate the instance on every (re)start — reusing a stopped instance is
  // flaky in Safari.
  const rec = new Ctor();
  recognition = rec;
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  rec.onresult = (event) => {
    // stop() can flush one last result after the user toggled off — stop
    // means stop, so drop it rather than resurrect the indicator (a stale
    // "Listening…" overlay is an inverted privacy signal).
    if (!listening || recognition !== rec) return;
    if (sessionExpired()) {
      stopVoice({ notice: 'Voice input stopped — session limit reached' });
      return;
    }
    const { finals, interim } = collectResults(event.results, event.resultIndex);
    for (const text of finals) {
      if (!deliverToActivePty(text)) {
        console.warn('[voice] transcript could not be delivered to the active pty');
        stopVoice();
        showError('Voice input stopped — transcript could not be delivered');
        return;
      }
      // Only *delivered* speech refills the silence budget: interim-only
      // ambient noise must not keep the mic hot forever.
      silentRestarts = 0;
    }
    showIndicator(interimTail(interim) || LISTENING_LABEL, 'live');
  };

  rec.onerror = (event) => {
    if (recognition !== rec) return;
    console.warn('[voice] recognition error:', event.error);
    // A permission or hardware failure means the earlier prime is stale
    // (revoked in settings, mic unplugged) — drop it so the next toggle
    // re-runs getUserMedia and can re-prompt.
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
      micPrimed = false;
    }
    const message = recognitionErrorMessage(event.error);
    if (!message) return;
    stopVoice();
    showError(message);
  };

  rec.onend = () => {
    // Only the current instance may restart — a superseded instance's end
    // (stop → quick re-toggle) must not spawn a duelling recognizer.
    if (!listening || recognition !== rec) return;
    silentRestarts++;
    const action = onEndAction(silentRestarts, Date.now() - sessionStart);
    if (action === 'pause') {
      stopVoice({ notice: 'Voice input paused — no speech detected' });
      return;
    }
    if (action === 'expire') {
      stopVoice({ notice: 'Voice input stopped — session limit reached' });
      return;
    }
    setTimeout(() => {
      if (!listening || recognition !== rec) return;
      try { startRecognition(); } catch {
        stopVoice();
        showError('Voice input stopped — could not restart the microphone');
      }
    }, RESTART_DELAY_MS);
  };

  rec.start();
}

export function toggleVoice() {
  if (listening) { stopVoice(); refocusTerminal(); return; }

  if (!recognitionCtor()) {
    showError('Voice input is not supported in this browser (try Chrome, Edge, or Safari)');
    return;
  }
  if (!window.isSecureContext) {
    showError('Voice input needs HTTPS or localhost — see docs/REMOTE.md (tailscale serve)');
    return;
  }
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (!agent || agent.state === 'DISCONNECTED') {
    showError('No running agent selected — open an agent first');
    return;
  }
  if (!canControlAgent(agent)) {
    showError('This agent is view-only');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('Could not start voice input — no microphone API in this browser');
    return;
  }

  listening = true;
  silentRestarts = 0;
  sessionStart = Date.now();
  const gen = ++voiceGen;
  const btn = micBtn();
  // aria-pressed reflects toggle intent now; the .listening recording pulse
  // and the live dot wait until the mic is actually granted — signalling
  // "recording" while a permission prompt sits open would be a lie.
  if (btn) btn.setAttribute('aria-pressed', 'true');

  if (micPrimed) {
    beginListening();
    refocusTerminal();
    return;
  }

  showIndicator('Requesting microphone…', 'notice');
  announce('Requesting microphone permission');
  // Acquire the mic permission FIRST, then start recognition. Starting
  // recognition while the browser's permission prompt is still open makes it
  // error with not-allowed immediately — so by the time the user clicks
  // "Allow", the mic is already off and their speech goes nowhere.
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    // The browser-level grant is real even if this toggle is no longer
    // current — record it before the staleness guard so an Allow that lands
    // after a stop isn't thrown away (and re-prompted for) next time.
    micPrimed = true;
    if (!listening || gen !== voiceGen) return;
    // The user may have deliberated on the prompt for minutes — that dwell
    // must not count against the dictation session cap.
    sessionStart = Date.now();
    beginListening();
  }).catch((err) => {
    console.warn('[voice] microphone unavailable:', err && err.name);
    // Same staleness guard as .then: a denial arriving after the user already
    // toggled off (or a session switch stopped voice) must not stomp that
    // stop's notice with a stale error.
    if (!listening || gen !== voiceGen) return;
    stopVoice();
    showError(mediaErrorMessage(err && err.name));
  });
  refocusTerminal();
}

// The mic is granted and recognition is about to run — only now do the
// recording signals (pulse, live dot, announcement) turn on.
function beginListening() {
  signalsOn = true;
  const btn = micBtn();
  if (btn) btn.classList.add('listening');
  showIndicator(LISTENING_LABEL, 'live');
  announce('Voice input started');
  try {
    startRecognition();
  } catch {
    stopVoice();
    showError('Could not start voice input');
  }
}

// Land keyboard focus in the active terminal so the Enter that submits the
// dictated prompt reaches the pty — not the mic button or whatever element
// happened to hold focus when Cmd+D fired.
function refocusTerminal() {
  const btn = micBtn();
  if (btn) btn.blur();
  const agent = activeSessionId ? agents.get(activeSessionId) : null;
  if (agent && agent.term) agent.term.focus();
}

// Stop dictation. opts.notice flashes an explanation when the stop wasn't
// user-initiated (session switch, agent ended, silence cap) — without it,
// in-flight speech would vanish with no cue.
export function stopVoice(opts = {}) {
  const wasListening = listening;
  const wasSignalling = signalsOn;
  listening = false;
  signalsOn = false;
  const btn = micBtn();
  if (btn) { btn.classList.remove('listening'); btn.setAttribute('aria-pressed', 'false'); }
  hideIndicator();
  if (recognition) {
    const rec = recognition;
    recognition = null;
    // Detach before abort so nothing this instance flushes can restart the
    // loop or repaint the indicator.
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try { rec.abort ? rec.abort() : rec.stop(); } catch {}
  }
  if (wasListening) {
    if (opts.notice) flashIndicator(opts.notice, 'notice');
    // Only announce a stop for a session whose start was announced — a
    // cancelled permission phase never started.
    else if (wasSignalling) announce('Voice input stopped');
  }
}

export function setupVoice() {
  const btn = micBtn();
  if (!btn) return;
  // Leave the button visible even when unsupported: clicking explains why
  // (missing API vs. insecure context) instead of silently hiding the feature.
  // toggleVoice handles the terminal refocus itself (shared with Cmd+D).
  btn.onclick = () => toggleVoice();
  // A hidden tab can't see the pulsing mic — don't keep capturing audio.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && listening) stopVoice();
  });
}
