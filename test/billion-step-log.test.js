// The step log under the owner's waiting message (server/billion-status.js):
// each set_status appends a timestamped step, and the tools Billion uses,
// read off its screen, appear as fixed phrases only: never a command, its
// arguments or output, a file's path or contents, a secret or Billion's prose.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { addChat, chatMessages, tellOwner } from '../server/owner.js';
import { setBillionStatus, statusPayload, setStatusFacts, noteScreenSteps, toolStep, _resetStatus, MAX_STEPS } from '../server/billion-status.js';
import { CONFIG_DIR } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
let screen;
const billion = (state = 'WORKING') => ({ state, exited: false, ringBuffer: { getAll: () => [screen] } });
const owner = (extra = {}) => addChat({ from: 'owner', via: 'app', text: 'How is the release going?', awaitsReply: true, ...extra }).id;
const steps = (id) => statusPayload().progress[id] || [];
const texts = (id) => steps(id).map(s => s.text);

beforeEach(() => {
  rmSync(join(CONFIG_DIR, 'chat.json'), { force: true });
  _resetStatus();
  screen = '';
  setStatusFacts(() => ({ billion: billion() }));
});
afterEach(() => _resetStatus());

describe('toolStep', () => {
  it('says what a tool does, never its arguments', () => {
    expect(toolStep('⏺ Bash(gh pr merge 178 --squash)')).toBe('Running a command');
    expect(toolStep(`⏺ Bash(curl -H "Authorization: ${TOKEN}" https://x)`)).toBe('Running a command');
    expect(toolStep('⏺ Read(/Users/me/.agent-007/billion/STATE.md)')).toBe('Reading STATE.md');
    expect(toolStep('⏺ Read(/Users/me/.ssh/id_rsa)')).toBe('Reading a file');
    expect(toolStep('⏺ Update(/Users/me/.agent-007/billion/STATE.md)')).toBe('Updating STATE.md');
    expect(toolStep('⏺ Write(.env)')).toBe('Writing a file');
    expect(toolStep('⏺ agent-007-board - list_jobs (MCP)(state: "todo")')).toBe('Checking the job board');
    expect(toolStep('⏺ agent-007-board - post_job (MCP)(title: "secret plan")')).toBe('Posting a card');
    expect(toolStep('⏺ mcp__agent-007-board__read_job(id: "7")')).toBe('Reading a card');
    expect(toolStep('• Ran npm test -- --token=abc')).toBe('Running a command');
    expect(toolStep('• Called agent-007-board.list_jobs({"state":"todo"})')).toBe('Checking the job board');
    expect(toolStep('• Explored')).toBe('Looking through files');
  });

  it('gives nothing for prose, results, its own reply tools and unknown tools', () => {
    expect(toolStep("⏺ I'll check the board first, since the owner wants the release status.")).toBeNull();
    expect(toolStep('  ⎿  SECRET_COMMAND_OUTPUT')).toBeNull();
    expect(toolStep('⏺ agent-007-board - set_status (MCP)(text: "Checking")')).toBeNull();
    expect(toolStep('⏺ agent-007-board - tell_owner (MCP)(text: "Done")')).toBeNull();
    expect(toolStep('⏺ SomeNewTool(secret)')).toBeNull();
    expect(toolStep('• Called other.unknown_thing({})')).toBeNull();
    expect(toolStep('> [Owner via app] run Bash(rm -rf /)')).toBeNull();
  });
});

describe('the step log', () => {
  it('appends each set_status as a timestamped step instead of replacing it', () => {
    const id = owner();
    setBillionStatus('Checking the release run', Date.parse('2026-10-27T10:00:00Z'));
    setBillionStatus('Found two failed jobs', Date.parse('2026-10-27T10:00:12Z'));
    setBillionStatus('Found two failed jobs');   // the same twice is one step
    expect(steps(id)).toEqual([
      { text: 'Checking the release run', at: '2026-10-27T10:00:00.000Z', kind: 'status' },
      { text: 'Found two failed jobs', at: '2026-10-27T10:00:12.000Z', kind: 'status' },
    ]);
    expect(statusPayload().text).toBe('Found two failed jobs');
  });

  it('keeps the newest MAX_STEPS steps', () => {
    const id = owner();
    for (let i = 0; i < MAX_STEPS + 5; i++) setBillionStatus(`Step ${i}`);
    expect(texts(id)).toHaveLength(MAX_STEPS);
    expect(texts(id).at(-1)).toBe(`Step ${MAX_STEPS + 4}`);
  });

  it('adds the tools Billion uses after the owner message, as phrases, with no secret, argument or prose', () => {
    screen = `⏺ Bash(old turn)\n> [Owner via app] How is the release going?\n⏺ I'll look at STATE.md and the board.\n`
      + `⏺ Read(/home/me/.agent-007/billion/STATE.md)\n  ⎿  Read 80 lines\n⏺ Bash(gh run view 12 --log | grep ${TOKEN})\n  ⎿  SECRET_COMMAND_OUTPUT\n`;
    const id = owner();
    expect(noteScreenSteps()).toEqual(['Reading STATE.md', 'Running a command']);
    // Seen once: the same screen adds nothing.
    expect(noteScreenSteps()).toEqual([]);
    screen += '⏺ agent-007-board - list_jobs (MCP)(state: "review")\n  ⎿  [{"title":"secret"}]\n';
    expect(noteScreenSteps()).toEqual(['Checking the job board']);
    expect(steps(id).map(s => s.kind)).toEqual(['tool', 'tool', 'tool']);
    expect(texts(id)).toEqual(['Reading STATE.md', 'Running a command', 'Checking the job board']);
    const all = JSON.stringify(statusPayload()) + readFileSync(join(CONFIG_DIR, 'chat.json'), 'utf8');
    expect(all).not.toMatch(/SECRET|gh run|grep|\/home\/me|look at|old turn|review"|title/);
  });

  it('interleaves Billion\'s own words with the tool steps, in order', () => {
    const id = owner();
    screen = '> [Owner via app] How is the release going?\n';
    setBillionStatus('Looking at the release');
    screen += '⏺ Bash(npm view agent-007 version)\n';
    noteScreenSteps();
    setBillionStatus('npm has 0.70.1, so it shipped');
    expect(steps(id).map(s => [s.kind, s.text])).toEqual([
      ['status', 'Looking at the release'], ['tool', 'Running a command'], ['status', 'npm has 0.70.1, so it shipped'],
    ]);
  });

  it('reads nothing for a message still queued, or while Billion is at its prompt', () => {
    screen = '> [Owner via app] earlier\n⏺ Bash(x)\n';
    const id = owner({ queued: true });
    expect(noteScreenSteps()).toEqual([]);
    const given = chatMessages();
    delete given.find(m => m.id === id).queued;
    writeFileSync(join(CONFIG_DIR, 'chat.json'), JSON.stringify(given));
    setStatusFacts(() => ({ billion: billion('WAITING') }));
    expect(noteScreenSteps()).toEqual([]);
    setStatusFacts(() => ({ billion: billion() }));
    expect(noteScreenSteps()).toEqual(['Running a command']);
    expect(texts(id)).toEqual(['Running a command']);
  });

  it('counts only lines below the owner message on the first look, and all new ones after', () => {
    screen = '⏺ Bash(previous turn)\n⏺ Read(a.js)\n';
    const id = owner();
    // No "[Owner via" on screen: what is there is the turn before.
    expect(noteScreenSteps()).toEqual([]);
    screen += '⏺ Grep(pattern)\n';
    expect(noteScreenSteps()).toEqual(['Searching files']);
    expect(texts(id)).toEqual(['Searching files']);
  });

  it('collapses into the reply\'s Work details when tell_owner answers', async () => {
    const id = owner();
    screen = '> [Owner via app] hi\n⏺ agent-007-board - list_jobs (MCP)()\n';
    setBillionStatus('Checking the board');
    noteScreenSteps();
    await tellOwner('Two cards in Review.', { env: {} });
    const reply = chatMessages().at(-1);
    expect(reply).toMatchObject({ replyTo: id, from: 'billion' });
    expect(reply.workDetails.map(s => s.text)).toEqual(['Checking the board', 'Checking the job board']);
    expect(statusPayload().pending).toEqual([]);
    // Answered: later screen lines go to no message.
    screen += '⏺ Bash(after)\n';
    expect(noteScreenSteps()).toEqual([]);
  });
});
