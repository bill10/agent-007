// Keyboard shortcuts
import { agents } from './state.js';
import { switchToSession } from './terminal.js';
import { toggleExplorer } from './explorer.js';

export function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;

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
  });
}
