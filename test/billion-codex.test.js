// Billion on either CLI (server/billion.js): the command for each, Codex's
// AGENTS.md, which CLI wins, and the order a switch goes in.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCommand } from '../lib/helpers.js';
import { billionCommand, agentsMdText, billionAgent, saveBillionAgent, billionAgentWarning, switchBillion, noAgentCommand, NO_CODEX_NOTICE } from '../server/billion.js';

const dir = '/home/me/.agent-007/billion';
const promptOf = (cmd) => parseCommand(cmd).args.at(-1);
const ID = '019a0000-0000-7000-8000-000000000002';

describe('billionCommand on Codex', () => {
  it('starts codex without approvals or sandbox, with the first-run prompt', () => {
    const cmd = billionCommand({ agent: 'codex', created: true, dir, projectsHint: null });
    expect(parseCommand(cmd).file).toBe('codex');
    expect(parseCommand(cmd).args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(promptOf(cmd)).toMatch(/first run/);
  });

  it('resumes its session by id after a restart, and only a real id', () => {
    expect(parseCommand(billionCommand({ agent: 'codex', created: false, codexSessionId: ID, dir })).args.slice(0, 2)).toEqual(['resume', ID]);
    expect(billionCommand({ agent: 'codex', created: false, codexSessionId: '--last', dir })).not.toMatch(/resume/);
    expect(billionCommand({ agent: 'codex', created: false, codexSessionId: null, dir })).not.toMatch(/resume/);
  });

  it('after a switch starts fresh and reads STATE.md and HANDOVER.md first', () => {
    for (const agent of ['codex', 'claude']) {
      const cmd = billionCommand({ agent, created: false, handover: true, hasConversation: true, codexSessionId: ID, dir });
      expect(cmd).not.toMatch(/resume|--continue/);
      expect(promptOf(cmd)).toMatch(/Read STATE\.md and then HANDOVER\.md/);
    }
  });

  it('without codex, prints how to install it', () => {
    expect(noAgentCommand('codex')).toContain(JSON.stringify(NO_CODEX_NOTICE).slice(1, 40));
  });
});

describe('AGENTS.md', () => {
  const charter = "# Billion's charter\n\nThe rules.\n";
  it('is CLAUDE.md with the charter in place of its import, so the owner\'s rules come after it', () => {
    const text = agentsMdText(charter, "# Billion\n\n@CHARTER.md\n\n## Owner's rules\n\n- Repos in ~/P\n");
    expect(text).toMatch(/^<!-- Written by Agent 007/);
    expect(text).not.toMatch(/^@CHARTER\.md/m);
    expect(text.indexOf('The rules.')).toBeLessThan(text.indexOf('- Repos in ~/P'));
  });

  it('still puts the charter first, and says who wins, when the import is gone', () => {
    const text = agentsMdText(charter, '- Never merge on Fridays\n');
    expect(text.indexOf('The rules.')).toBeLessThan(text.indexOf('Fridays'));
    expect(text).toMatch(/take precedence over the charter above/);
  });

  it('copies a charter that holds $& patterns as it is', () => {
    expect(agentsMdText('cost $& and $1\n', '@CHARTER.md\n')).toContain('cost $& and $1');
  });
});

describe('which CLI Billion runs on', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'a007-bagent-')), 'billion-agent.json');
  it('is BILLION_AGENT, claude by default and for anything else', () => {
    expect(billionAgent({}, file())).toBe('claude');
    expect(billionAgent({ BILLION_AGENT: ' Codex ' }, file())).toBe('codex');
    expect(billionAgent({ BILLION_AGENT: 'gemini' }, file())).toBe('claude');
    expect(billionAgentWarning({ BILLION_AGENT: 'gemini' })).toMatch(/not claude or codex/);
    expect(billionAgentWarning({ BILLION_AGENT: 'codex' })).toBeNull();
  });

  it('a saved switch wins until BILLION_AGENT changes', () => {
    const f = file();
    saveBillionAgent('codex', {}, f);
    expect(billionAgent({}, f)).toBe('codex');
    expect(billionAgent({ BILLION_AGENT: 'claude' }, f)).toBe('claude');
    saveBillionAgent('claude', { BILLION_AGENT: 'codex' }, f);
    expect(billionAgent({ BILLION_AGENT: 'codex' }, f)).toBe('claude');
    writeFileSync(f, 'not json');
    expect(billionAgent({ BILLION_AGENT: 'codex' }, f)).toBe('codex');
  });
});

describe('switchBillion', () => {
  const steps = () => {
    const order = [];
    return {
      order,
      writeHandover: vi.fn((d, o) => order.push(['handover', o.from, o.to])),
      saveAgent: vi.fn((a) => order.push(['save', a])),
      stop: vi.fn(async () => { order.push(['stop']); return { queue: ['mail'], ahead: 0 }; }),
      start: vi.fn((o) => { order.push(['start', o]); return { session: { id: 'new' } }; }),
    };
  };

  it('hands over, saves, stops, then starts the other CLI with the mail', async () => {
    const s = steps();
    const result = await switchBillion({ current: { agent: 'claude', exited: false }, dir, ...s });
    expect(result).toEqual({ session: { id: 'new' } });
    expect(s.order).toEqual([
      ['handover', 'claude', 'codex'], ['save', 'codex'], ['stop'],
      ['start', { handover: true, carried: { queue: ['mail'], ahead: 0 } }],
    ]);
  });

  it('starts a stopped Billion on the new CLI without stopping anything', async () => {
    const s = steps();
    await switchBillion({ to: 'claude', current: null, currentAgent: 'codex', dir, ...s });
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.order[0]).toEqual(['handover', 'codex', 'claude']);
  });

  it('keeps the current CLI when the conversation handover cannot be written', async () => {
    const s = steps();
    s.writeHandover.mockImplementation(() => { throw new Error('disk full'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await switchBillion({ current: { agent: 'codex' }, dir, ...s })).error).toMatch(/handover/);
    expect(s.saveAgent).not.toHaveBeenCalled();
    expect(s.stop).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
  });

  it('refuses the CLI it already runs on, and one it does not know', async () => {
    const s = steps();
    expect((await switchBillion({ to: 'codex', current: { agent: 'codex', exited: false }, dir, ...s })).error).toMatch(/already runs on Codex/);
    expect((await switchBillion({ to: 'gpt', current: null, currentAgent: 'claude', dir, ...s })).error).toMatch(/not gpt/);
    expect(s.order).toEqual([]);
  });
});
