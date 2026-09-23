// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));

import { send } from '../public/modules/ws.js';
import { agents, setSelf, setActiveSession } from '../public/modules/state.js';
import { handlePtySize, fitActiveTerminal } from '../public/modules/terminal.js';

// A shared pty has one size, set by the server (pty-size); a window only
// proposes its own size and renders at whatever the server settles on.
describe('terminal size follows the pty', () => {
  const addAgent = (fields = {}) => {
    const agent = {
      ownerId: 'u1',
      term: { cols: 120, rows: 30, resize: vi.fn() },
      termEl: { offsetWidth: 800 },
      fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 90, rows: 25 })) },
      ...fields,
    };
    agents.clear();
    agents.set('s1', agent);
    setActiveSession('s1');
    return agent;
  };

  beforeEach(() => { send.mockClear(); setSelf('u1', true); });

  it('resizes to pty-size only when it differs', () => {
    const a = addAgent();
    handlePtySize({ sessionId: 's1', cols: 120, rows: 30 });
    expect(a.term.resize).not.toHaveBeenCalled();
    handlePtySize({ sessionId: 's1', cols: 60, rows: 20 });
    expect(a.term.resize).toHaveBeenCalledWith(60, 20);
    expect(() => handlePtySize({ sessionId: 'gone', cols: 1, rows: 1 })).not.toThrow();
  });

  it('owner proposes its size to the server instead of fitting locally', () => {
    const a = addAgent();
    fitActiveTerminal();
    expect(send).toHaveBeenCalledWith({ type: 'pty-resize', sessionId: 's1', cols: 90, rows: 25 });
    expect(a.fitAddon.fit).not.toHaveBeenCalled();
    expect(a.term.resize).not.toHaveBeenCalled();
  });

  it('a window showing no terminal tells the server so', () => {
    addAgent({ termEl: { offsetWidth: 0 } });   // job board, another phone view
    fitActiveTerminal();
    expect(send).toHaveBeenLastCalledWith({ type: 'pty-resize', sessionId: null });
    setActiveSession(null);
    fitActiveTerminal();
    expect(send).toHaveBeenLastCalledWith({ type: 'pty-resize', sessionId: null });
  });

  it('sends nothing when no size can be proposed', () => {
    addAgent({ fitAddon: { fit: vi.fn(), proposeDimensions: () => undefined } });
    fitActiveTerminal();
    expect(send).not.toHaveBeenCalled();
  });

  it('a viewer reports too, and never resizes its copy itself', () => {
    const a = addAgent({ ownerId: 'u2' });
    fitActiveTerminal();
    expect(send).toHaveBeenCalledWith({ type: 'pty-resize', sessionId: 's1', cols: 90, rows: 25 });
    expect(a.term.resize).not.toHaveBeenCalled();
  });
});
