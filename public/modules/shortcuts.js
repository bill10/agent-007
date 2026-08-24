// Keyboard shortcuts
import { agents } from './state.js';
import { switchToSession } from './terminal.js';
import { toggleExplorer } from './explorer.js';
import { toggleVoice } from './voice.js';

// Single source of truth for Cmd+<key> global shortcuts. terminal.js uses the
// same predicate so xterm passes exactly the chords the document handler acts
// on — an asymmetric filter would create dead keystrokes (blocked by xterm,
// ignored here). Add a new shortcut to the key list and the handler below,
// nowhere else. Shift chords are excluded naturally: e.key is 'E', not 'e'.
export const GLOBAL_SHORTCUT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'e', 'n', 'd'];

export function isGlobalShortcut(e) {
  return e.metaKey && !e.ctrlKey && !e.altKey && GLOBAL_SHORTCUT_KEYS.includes(e.key);
}

export function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!isGlobalShortcut(e) || e.repeat) return;

    // Cmd+1..9: switch to agent N
    if (e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      const sessionIds = [...agents.keys()];
      if (idx < sessionIds.length) {
        switchToSession(sessionIds[idx]);
      }
      return;
    }

    // Cmd+E: toggle explorer (disabled below 900px)
    if (e.key === 'e') {
      e.preventDefault();
      if (window.innerWidth > 900) toggleExplorer();
      return;
    }

    // Cmd+N: open spawn form
    if (e.key === 'n') {
      e.preventDefault();
      document.getElementById('btn-new-agent').click();
      return;
    }

    // Cmd+D: toggle voice input
    if (e.key === 'd') {
      e.preventDefault();
      toggleVoice();
      return;
    }
  });
}
