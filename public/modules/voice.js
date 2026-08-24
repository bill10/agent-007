// Voice input — dictate into the active terminal via the Web Speech API.
// Finalized speech is sent as pty-input (exactly like typing); nothing is
// auto-submitted — the user still presses Enter to send the prompt.
import { agents, activeSessionId, canControlAgent } from './state.js';
import { send } from './ws.js';

// User intent: mic toggled on. The browser stops recognition on its own after
// silence, so onend restarts it while this stays true.
let listening = false;
let recognition = null;

function recognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Collapse whitespace and separate consecutive utterances with a space.
// Exported for tests.
export function normalizeTranscript(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t ? t + ' ' : '';
}

function indicator() { return document.getElementById('voice-indicator'); }
function micBtn() { return document.getElementById('btn-voice'); }

function showIndicator(text, isError) {
  const el = indicator();
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.style.display = 'flex';
}

function hideIndicator() {
  const el = indicator();
  if (el) el.style.display = 'none';
}

function showError(text) {
  showIndicator(text, true);
  setTimeout(() => { if (!listening) hideIndicator(); }, 4000);
}

function deliverToActivePty(text) {
  if (!activeSessionId) return;
  const agent = agents.get(activeSessionId);
  if (!agent || !canControlAgent(agent)) return;
  send({ type: 'pty-input', sessionId: activeSessionId, data: text });
}

function startRecognition() {
  const Ctor = recognitionCtor();
  // Recreate the instance on every (re)start — reusing a stopped instance is
  // flaky in Safari.
  recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = normalizeTranscript(result[0].transcript);
        if (text) deliverToActivePty(text);
      } else {
        interim += result[0].transcript;
      }
    }
    showIndicator(interim ? `\u{1F399} ${interim}` : '\u{1F399} Listening…', false);
  };

  recognition.onerror = (event) => {
    // no-speech fires on every silence timeout and aborted on our own stop().
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      stopVoice();
      showError('Microphone access denied — allow it in your browser settings');
      return;
    }
    if (event.error === 'audio-capture') {
      stopVoice();
      showError('No microphone found');
      return;
    }
    stopVoice();
    showError(`Voice input error: ${event.error}`);
  };

  recognition.onend = () => {
    if (!listening) return;
    // Browser timed out on silence — keep going until the user toggles off.
    setTimeout(() => { if (listening) { try { startRecognition(); } catch { stopVoice(); } } }, 250);
  };

  recognition.start();
}

export function toggleVoice() {
  if (listening) { stopVoice(); return; }

  if (!recognitionCtor()) {
    showError('Voice input is not supported in this browser (try Chrome, Edge, or Safari)');
    return;
  }
  if (!window.isSecureContext) {
    showError('Voice input needs HTTPS or localhost — see docs/REMOTE.md (tailscale serve)');
    return;
  }
  if (!activeSessionId || !agents.get(activeSessionId)) {
    showError('No agent selected — open an agent first');
    return;
  }
  if (!canControlAgent(agents.get(activeSessionId))) {
    showError('This agent is view-only');
    return;
  }

  listening = true;
  micBtn()?.classList.add('listening');
  showIndicator('\u{1F399} Listening…', false);
  try {
    startRecognition();
  } catch {
    stopVoice();
    showError('Could not start voice input');
  }
}

export function stopVoice() {
  listening = false;
  micBtn()?.classList.remove('listening');
  hideIndicator();
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
}

export function setupVoice() {
  const btn = micBtn();
  if (!btn) return;
  // Leave the button visible even when unsupported: clicking explains why
  // (missing API vs. insecure context) instead of silently hiding the feature.
  btn.onclick = toggleVoice;
}
