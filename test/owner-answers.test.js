// Answering Billion's questions (server/owner.js): choices, the Q numbers,
// open → answered / dismissed, answers from the app and from Telegram (buttons
// and replies), and waiting.json written before any of that. fetch is mocked:
// nothing here talks to Telegram.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  notifyOwner, handleUpdate, waitingItems, waitingPayload, dismissWaiting, answerWaiting, checkChoices,
  pollOnce, NOTIFY_WINDOW_MS, resolveQuestion, reopenQuestion, UNDO_MS, chatMessages, questionProject,
  questionType, QUESTION_TYPES,
} from '../server/owner.js';
import { handleMcpMessage, NOTIFY_OWNER_TOOL } from '../server/mcp.js';
import { dropMessages, takeMessages } from '../server/messages.js';
import { mayAnswerOwner } from '../server/ws.js';
import { USERS_PATH } from '../server/auth.js';
import { sessions, CONFIG_DIR, config } from '../server/state.js';

const TOKEN = '123456:SECRET-token';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
const reply = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
let fetchMock;
let clock = 2e12;
const now = () => (clock += 10 * NOTIFY_WINDOW_MS);
const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ method: url.split('/').pop(), body: JSON.parse(init.body) }));

let b;
const typed = () => b.pty.write.mock.calls.map(c => c[0]).join('');

beforeEach(() => {
  fetchMock = vi.fn(async () => reply({ message_id: 900 }));
  vi.stubGlobal('fetch', fetchMock);
  rmSync(join(CONFIG_DIR, 'waiting.json'), { force: true });
  b = {
    id: 'answers-billion', name: 'Billion', isBillion: true, command: 'claude', state: 'WAITING', exited: false,
    ownerId: null, stateChangedAt: Date.now() - 5000, recentStrippedLines: [], isTUI: true, lastOutputAt: 0, pty: { write: vi.fn() },
  };
  sessions.set(b.id, b);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessions.delete(b.id);
  dropMessages(b.id);
});

const ask = (text, opts = {}) => notifyOwner(text, { env: ENV, now: now(), ...opts });

describe('choices and recommended', () => {
  it('accepts 2 to 5 short distinct choices and a recommended one of them', () => {
    expect(checkChoices(undefined, undefined)).toBeNull();
    expect(checkChoices(['yes', 'no'], 'yes')).toBeNull();
    expect(checkChoices(['a', 'b', 'c', 'd', 'e'])).toBeNull();
    expect(checkChoices(['yes'])).toMatch(/2 to 5/);
    expect(checkChoices(['a', 'b', 'c', 'd', 'e', 'f'])).toMatch(/2 to 5/);
    expect(checkChoices('yes,no')).toMatch(/2 to 5/);
    expect(checkChoices(['yes', ' '])).toMatch(/1 to 40/);
    expect(checkChoices(['yes', 'x'.repeat(41)])).toMatch(/1 to 40/);
    expect(checkChoices(['yes', 'yes'])).toMatch(/differ/);
    expect(checkChoices(['yes', 'no'], 'maybe')).toMatch(/one of the choices/);
    expect(checkChoices(undefined, 'yes')).toMatch(/needs choices/);
    expect(checkChoices(['1', '2'], 1)).toMatch(/one of the choices/);
  });

  it('refuses a bad pick before pinning or sending anything', async () => {
    expect((await ask('Buy?', { choices: ['yes', 'no'], recommended: 'maybe' })).error).toMatch(/one of the choices/);
    expect(waitingItems()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are in the MCP schema and reach notifyOwner', async () => {
    const { properties } = NOTIFY_OWNER_TOOL.inputSchema;
    expect(properties.choices).toMatchObject({ type: 'array', minItems: 2, maxItems: 5 });
    expect(properties.recommended.type).toBe('string');
    const notify = vi.fn(async () => ({ ok: true, n: 4 }));
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'Buy?', choices: ['yes', 'no'], recommended: 'yes' } } },
      { session: { isBillion: true }, notifyOwner: notify });
    expect(notify).toHaveBeenCalledWith('Buy?', { choices: ['yes', 'no'], recommended: 'yes', urgency: undefined, project: undefined });
    expect(res.result.content[0].text).toContain('[Owner via app] Q4:');
  });

  it('go to Telegram as buttons, the recommended one marked, callback_data under 64 bytes', async () => {
    expect(await ask('Buy the domain?', { choices: ['yes', 'no'], recommended: 'yes' })).toEqual({ ok: true, n: 1 });
    const [item] = waitingItems();
    expect(item).toMatchObject({ n: 1, status: 'open', choices: ['yes', 'no'], recommended: 'yes', tgMessageId: 900 });
    const { body } = calls()[0];
    expect(body.text).toBe('Q1: Buy the domain?');
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons.map(x => x.text)).toEqual(['yes (recommended)', 'no']);
    expect(buttons.map(x => x.callback_data)).toEqual([`${item.id}:0`, `${item.id}:1`]);
    for (const x of buttons) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('answering in the app', () => {
  it('types "[Owner via app] Q<n>: <answer>" with the question for context, and marks it answered', async () => {
    await ask('first');
    await ask('Spend $20 on a domain for the launch page? I recommend yes, it is cheap.', { choices: ['yes', 'no'] });
    const item = waitingItems()[1];
    const broadcast = vi.fn();
    fetchMock.mockClear();
    expect(await answerWaiting(item.id, 'yes', 'app', { broadcast, env: ENV })).toMatchObject({ ok: true });
    expect(typed()).toContain('[Owner via app] Q2: yes (re: "Spend $20 on a domain for the launch page? I recommend yes,…")');
    expect(waitingItems()[1]).toMatchObject({ status: 'answered', answer: 'yes', answeredVia: 'app' });
    expect(broadcast).toHaveBeenCalledWith(waitingPayload());
    // The phone's copy says so and loses its buttons.
    expect(calls()).toEqual([{ method: 'editMessageText', body: { chat_id: '42', message_id: 900, text: `Q2: ${item.text}\n\nAnswered in app: yes` } }]);
  });

  it('edits the phone\'s copy even when the app answered before the send came back', async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise(r => { finish = () => r(reply({ message_id: 901 })); }));
    const asked = ask('Ship it?', { choices: ['yes', 'no'] });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await answerWaiting(waitingItems()[0].id, 'yes', 'app', { env: ENV })).ok).toBe(true);
    finish();
    await asked;
    expect(calls().at(-1)).toEqual({ method: 'editMessageText', body: { chat_id: '42', message_id: 901, text: 'Q1: Ship it?\n\nAnswered in app: yes' } });
  });

  it('keeps the card open when Billion is not running, and refuses a second answer', async () => {
    await ask('Which name?', { env: {} });
    const [item] = waitingItems();
    sessions.delete(b.id);
    expect(await answerWaiting(item.id, 'Raven', 'app')).toEqual({ error: 'Billion is not running' });
    expect(waitingItems()[0].status).toBe('open');
    sessions.set(b.id, b);
    expect(await answerWaiting(item.id, '  ', 'app')).toEqual({ error: 'The answer is empty.' });
    expect((await answerWaiting(item.id, 'Raven', 'app')).ok).toBe(true);
    expect((await answerWaiting(item.id, 'Crow', 'app')).error).toMatch(/Q1 was answered already: Raven/);
    expect(dismissWaiting(item.id)).toBe(true);
    expect(waitingItems()[0].status).toBe('dismissed');
    expect((await answerWaiting(item.id, 'Crow', 'app')).error).toMatch(/gone/);
    expect(waitingPayload().items).toEqual([]);
  });
});

describe('answering on Telegram', () => {
  const tap = (chat, data, id = 'cq1') => ({ update_id: 1, callback_query: { id, data, message: { chat: { id: chat }, message_id: 900 } } });

  it('a button tap answers the question, acknowledges the tap, and edits the message', async () => {
    await ask('Buy it?', { choices: ['yes', 'no'], recommended: 'yes' });
    const [item] = waitingItems();
    fetchMock.mockClear();
    expect(await handleUpdate(tap(42, `${item.id}:1`), { env: ENV })).toBe('answered');
    expect(typed()).toContain('[Owner via Telegram] Q1: no (re: "Buy it?")');
    expect(waitingItems()[0]).toMatchObject({ status: 'answered', answer: 'no', answeredVia: 'telegram' });
    const sent = calls();
    expect(sent.find(c => c.method === 'editMessageText').body.text).toBe('Q1: Buy it?\n\nAnswered: no');
    expect(sent.find(c => c.method === 'answerCallbackQuery').body).toEqual({ callback_query_id: 'cq1', text: 'Sent: no' });
    // A second tap only hears that it was answered.
    expect(await handleUpdate(tap(42, `${item.id}:0`, 'cq2'), { env: ENV })).toBe('stale');
    expect(calls().at(-1).body).toEqual({ callback_query_id: 'cq2', text: 'Already answered: no' });
  });

  it('ignores a tap from any other chat, without a word', async () => {
    await ask('Buy it?', { choices: ['yes', 'no'] });
    const [item] = waitingItems();
    fetchMock.mockClear();
    expect(await handleUpdate(tap(43, `${item.id}:0`), { env: ENV })).toBe('ignored');
    expect(await handleUpdate(tap(42, `${item.id}:0`), { env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe('ignored');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(b.pty.write).not.toHaveBeenCalled();
    expect(waitingItems()[0].status).toBe('open');
  });

  it('a typed reply to a question answers it; a plain message goes through as before', async () => {
    await ask('Which name?');
    const msg = (text, extra) => ({ update_id: 2, message: { chat: { id: 42 }, text, ...extra } });
    expect(await handleUpdate(msg('Raven', { reply_to_message: { message_id: 900 } }), { env: ENV })).toBe('answered');
    expect(typed()).toContain('[Owner via Telegram] Q1: Raven (re: "Which name?")');
    expect(waitingItems()[0]).toMatchObject({ status: 'answered', answer: 'Raven' });
    expect(await handleUpdate(msg('and ship it', { reply_to_message: { message_id: 555 } }), { env: ENV })).toBe('delivered');
    expect(await handleUpdate(msg('hello'), { env: ENV })).toBe('delivered');
    expect(waitingItems()).toHaveLength(1);
  });

  it('asks Telegram for button taps as well as messages', async () => {
    fetchMock.mockResolvedValueOnce(reply([]));
    await pollOnce(0, { env: ENV });
    expect(calls()[0].body.allowed_updates).toEqual(['message', 'callback_query']);
  });
});

describe('waiting.json from before answers', () => {
  it('reads old items as open, numbered in order, and carries on from there', async () => {
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([
      { id: 'old-1', text: 'Old one', at: '2026-01-01T00:00:00.000Z' },
      { id: 'old-2', text: 'Old two', at: '2026-01-02T00:00:00.000Z' },
    ]));
    expect(waitingItems().map(i => [i.id, i.n, i.status])).toEqual([['old-1', 1, 'open'], ['old-2', 2, 'open']]);
    expect((await answerWaiting('old-2', 'done', 'app')).ok).toBe(true);
    expect(typed()).toContain('[Owner via app] Q2: done');
    expect((await ask('New', { env: {} })).n).toBe(3);
    expect(waitingItems().map(i => [i.n, i.status])).toEqual([[1, 'open'], [2, 'answered'], [3, 'open']]);
  });
});

describe('the list\'s size', () => {
  it('keeps the newest 50 open questions and the newest 30 closed ones', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, n: i + 1, text: 't', at: '', status: i % 2 ? 'open' : 'answered' }));
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify(items));
    dismissWaiting('x1');   // any save trims
    const kept = waitingItems();
    expect(kept.filter(i => i.status === 'open')).toHaveLength(49);
    expect(kept.filter(i => i.status !== 'open')).toHaveLength(30);
    expect(kept.at(-1).id).toBe('x99');
  });
});

describe('who may answer', () => {
  it('anyone on a single-user server; nobody once user accounts are on', () => {
    expect(mayAnswerOwner()).toBe(true);
    writeFileSync(USERS_PATH, JSON.stringify([{ id: 'u1', displayName: 'A', color: '#d4a847', tokenHash: 'x' }]));
    try {
      expect(mayAnswerOwner()).toBe(false);
    } finally {
      rmSync(USERS_PATH, { force: true });
    }
  });
});

describe('resolve_question', () => {
  const openCount = () => waitingPayload().items.filter(i => i.status === 'open').length;

  it('closes an open question by number, drops the badge, edits the phone copy, types nothing', async () => {
    await ask('Ship it?', { choices: ['yes', 'no'] });
    await ask('Option B?');
    expect(openCount()).toBe(2);
    fetchMock.mockClear();
    const broadcast = vi.fn();
    const result = await resolveQuestion({ number: 1 }, ' yes,  ship ', { broadcast, env: ENV });
    expect(result.item).toMatchObject({ n: 1, status: 'answered', answer: 'yes, ship', answeredVia: 'terminal' });
    expect(openCount()).toBe(1);
    expect(broadcast).toHaveBeenCalledWith(waitingPayload());
    expect(calls()).toEqual([{ method: 'editMessageText', body: { chat_id: '42', message_id: 900, text: 'Q1: Ship it?\n\nAnswered in terminal: yes, ship' } }]);
    expect(typed()).toBe('');
  });

  it('closes by id too', async () => {
    const { id } = (await ask('Option B?')) && waitingItems()[0];
    expect((await resolveQuestion({ id }, 'go', { env: ENV })).item.status).toBe('answered');
  });

  it('errors for an unknown, answered or dismissed question and changes nothing', async () => {
    await ask('One?');
    await ask('Two?');
    expect((await resolveQuestion({ number: 9 }, 'x', { env: ENV })).error).toMatch(/no Q9/);
    expect((await resolveQuestion({ id: 'nope' }, 'x', { env: ENV })).error).toMatch(/no question nope/);
    await resolveQuestion({ number: 1 }, 'yes', { env: ENV });
    expect((await resolveQuestion({ number: 1 }, 'no', { env: ENV })).error).toMatch(/Q1 was answered already: yes/);
    dismissWaiting(waitingItems()[1].id);
    expect((await resolveQuestion({ number: 2 }, 'no', { env: ENV })).error).toMatch(/Q2 was dismissed/);
    expect((await resolveQuestion({ number: 1 }, '  ', { env: ENV })).error).toMatch(/empty/);
    expect(waitingItems().map(i => [i.status, i.answer])).toEqual([['answered', 'yes'], ['dismissed', undefined]]);
  });

  it('is Billion\'s tool only, over MCP', async () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session }).result.tools.map(t => t.name);
    expect(list({ isBillion: true })).toContain('resolve_question');
    expect(list({})).not.toContain('resolve_question');
    const call = (args, ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'resolve_question', arguments: args } }, ctx);
    expect((await call({ number: 1, answer: 'yes' }, { session: {} })).error.message).toMatch(/Unknown tool/);
    expect((await call({ answer: 'yes' }, { session: { isBillion: true } })).result.content[0].text).toMatch(/number or id/);
    const resolve = vi.fn(async () => ({ ok: true, item: { n: 3, answer: 'yes' } }));
    const res = await call({ number: 3, answer: 'yes' }, { session: { isBillion: true }, resolveQuestion: resolve });
    expect(resolve).toHaveBeenCalledWith({ number: 3, id: undefined }, 'yes');
    expect(res.result.content[0].text).toBe('Q3 is marked answered: yes');
  });
});

describe('reopen_question and Undo', () => {
  it('puts an answered question back to open by number, clears the answer, re-broadcasts, sends nothing', async () => {
    await ask('Ship it?', { choices: ['yes', 'no'] });
    await answerWaiting(waitingItems()[0].id, 'yes', 'app', { env: ENV });
    fetchMock.mockClear();
    b.pty.write.mockClear();
    const broadcast = vi.fn();
    const result = await reopenQuestion({ number: 1 }, { broadcast });
    expect(result.item).toMatchObject({ n: 1, status: 'open' });
    expect(waitingItems()[0]).not.toHaveProperty('answer');
    expect(broadcast).toHaveBeenCalledWith(waitingPayload());
    const bubble = chatMessages().find(m => m.q?.id === result.item.id);
    expect(bubble.q).toMatchObject({ status: 'open', choices: ['yes', 'no'] });
    expect(bubble.q).not.toHaveProperty('answer');
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat-message', message: bubble });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(typed()).toBe('');
    // And it can be answered again.
    expect((await answerWaiting(waitingItems()[0].id, 'no', 'app', { env: ENV })).ok).toBe(true);
  });

  it('refuses an unknown, open or dismissed question', async () => {
    await ask('One?');
    await ask('Two?');
    expect((await reopenQuestion({ number: 9 })).error).toMatch(/no Q9/);
    expect((await reopenQuestion({ id: 'nope' })).error).toMatch(/no question nope/);
    expect((await reopenQuestion({ number: 1 })).error).toBe('Q1 is open already.');
    dismissWaiting(waitingItems()[1].id);
    expect((await reopenQuestion({ number: 2 })).error).toMatch(/Q2 was dismissed/);
  });

  it('from the owner: only within the minute, and Billion hears the answer is withdrawn', async () => {
    await ask('Ship it?');
    const { id } = waitingItems()[0];
    await answerWaiting(id, 'yes', 'app', { env: ENV });
    const at = Date.parse(waitingItems()[0].answeredAt);
    expect((await reopenQuestion({ id }, { owner: true, now: at + UNDO_MS + 1 })).error).toMatch(/Too late to undo Q1/);
    expect(waitingItems()[0].status).toBe('answered');
    expect((await reopenQuestion({ id }, { owner: true, now: at + 1000 })).ok).toBe(true);
    // Queued behind the answer itself.
    expect(JSON.stringify(takeMessages(b.id).queue)).toContain('[Owner via app] Q1: undo my answer \\"yes\\"; the question is open again.');
    expect(waitingItems()[0].status).toBe('open');
  });

  it('is Billion\'s tool only, over MCP', async () => {
    const list = (session) => handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session }).result.tools.map(t => t.name);
    expect(list({ isBillion: true })).toContain('reopen_question');
    expect(list({})).not.toContain('reopen_question');
    const call = (args, ctx) => handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reopen_question', arguments: args } }, ctx);
    expect((await call({}, { session: { isBillion: true } })).result.content[0].text).toMatch(/number or id/);
    const reopen = vi.fn(async () => ({ ok: true, item: { n: 3 } }));
    const res = await call({ number: 3 }, { session: { isBillion: true }, reopenQuestion: reopen });
    expect(reopen).toHaveBeenCalledWith({ number: 3, id: undefined });
    expect(res.result.content[0].text).toBe('Q3 is open again.');
  });
});

describe('urgency', () => {
  it('is in the MCP schema and reaches notifyOwner', async () => {
    expect(NOTIFY_OWNER_TOOL.inputSchema.properties.urgency.enum).toEqual(['blocking', 'normal', 'low']);
    const notify = vi.fn(async () => ({ ok: true, n: 1 }));
    await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'Merge?', urgency: 'blocking' } } },
      { session: { isBillion: true }, notifyOwner: notify });
    expect(notify).toHaveBeenCalledWith('Merge?', expect.objectContaining({ urgency: 'blocking' }));
  });

  it('defaults to normal, is kept on the item, and refuses an unknown level before pinning or sending', async () => {
    await ask('Name?');
    await ask('Merge #12?', { urgency: 'blocking' });
    await ask('Rename later?', { urgency: 'low' });
    expect(waitingItems().map(i => i.urgency)).toEqual(['normal', 'blocking', 'low']);
    expect(waitingPayload().items.map(i => i.urgency)).toEqual(['normal', 'blocking', 'low']);
    fetchMock.mockClear();
    expect((await ask('Now?', { urgency: 'urgent' })).error).toBe('urgency must be "blocking", "normal" or "low", not "urgent".');
    expect(waitingItems()).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts "! " before blocking questions on Telegram only', async () => {
    await ask('Merge #12?', { urgency: 'blocking' });
    await ask('Name?', { urgency: 'normal' });
    await ask('Rename later?', { urgency: 'low' });
    expect(calls().map(c => c.body.text)).toEqual(['! Q1: Merge #12?', 'Q2: Name?', 'Q3: Rename later?']);
  });

  it('reads as normal on items saved before it existed', () => {
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([{ id: 'old', n: 1, text: 'Old?', at: '2026-01-01T00:00:00Z', status: 'open' }]));
    expect(waitingItems()[0].urgency).toBe('normal');
  });
});

describe('project', () => {
  const REPOS = ['agent-007', 'finnamon', 'Mirage'];

  it('takes a board repo by name in any case, "general", or an unknown name lower-cased and capped', () => {
    expect(questionProject('finnamon', 'x', REPOS)).toBe('finnamon');
    expect(questionProject(' MIRAGE ', 'x', REPOS)).toBe('Mirage');
    expect(questionProject('General', 'about agent-007', REPOS)).toBe('general');
    expect(questionProject('Side-Project', 'x', REPOS)).toBe('side-project');
    expect(questionProject('X'.repeat(90), 'x', REPOS)).toBe('x'.repeat(40));
  });

  it('is read off a GitHub PR, issue or repo URL whose repo is on the board', () => {
    expect(questionProject(undefined, 'Merge https://github.com/bill10/finnamon/pull/12 ?', REPOS)).toBe('finnamon');
    expect(questionProject('', 'See github.com/someone/Agent-007/issues/3', REPOS)).toBe('agent-007');
    expect(questionProject(undefined, 'Clone https://github.com/x/mirage.git first?', REPOS)).toBe('Mirage');
    // A repo not on the board: then a name in the text, else general.
    expect(questionProject(undefined, 'https://github.com/x/other/pull/1 blocks finnamon', REPOS)).toBe('finnamon');
  });

  it('is read off a board repo named in the text, as a word, else general', () => {
    expect(questionProject(undefined, 'Ship agent-007 tonight?', REPOS)).toBe('agent-007');
    expect(questionProject(undefined, 'Rename finnamon-web?', REPOS)).toBe('general');
    expect(questionProject(undefined, 'Buy a domain?', REPOS)).toBe('general');
    expect(questionProject(undefined, 'Buy a domain?', [])).toBe('general');
  });

  it('is in the MCP schema, reaches notifyOwner, is kept on the item and its bubble, and old items read as general', async () => {
    expect(NOTIFY_OWNER_TOOL.inputSchema.properties.project.type).toBe('string');
    expect(NOTIFY_OWNER_TOOL.description).toMatch(/Pass project/);
    const notify = vi.fn(async () => ({ ok: true, n: 1 }));
    await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'Merge?', project: 'finnamon' } } },
      { session: { isBillion: true }, notifyOwner: notify });
    expect(notify).toHaveBeenCalledWith('Merge?', expect.objectContaining({ project: 'finnamon' }));

    const saved = config.repos;
    config.repos = [{ path: '/code/finnamon' }];
    try {
      await ask('Merge https://github.com/bill10/finnamon/pull/4?');
      await ask('Name?', { project: 'Side' });
      expect(waitingPayload().items.map(i => i.project)).toEqual(['finnamon', 'side']);
      expect(chatMessages().filter(m => m.q).slice(-2).map(m => m.q.project)).toEqual(['finnamon', 'side']);
      expect((await ask('Now?', { project: 7 })).error).toMatch(/project must be/);
    } finally { config.repos = saved; }
    writeFileSync(join(CONFIG_DIR, 'waiting.json'), JSON.stringify([{ id: 'old', n: 1, text: 'Old?', at: '2026-01-01T00:00:00Z', status: 'open' }]));
    expect(waitingItems()[0].project).toBe('general');
  });
});

describe('type', () => {
  it('takes one from the list in any case; any other name is other', () => {
    for (const t of QUESTION_TYPES) expect(questionType(t, 'Merge the PR?')).toBe(t);
    expect(questionType(' Finance ', 'x')).toBe('finance');
    expect(questionType('legal', 'Merge the PR?')).toBe('other');
    expect(questionType(7, 'x')).toBe('other');
    // Empty is none: read off the text.
    expect(questionType('', 'Merge the PR?')).toBe('engineering');
  });

  it('is read off the text when not given, the first rule that matches winning', () => {
    const cases = {
      finance: ['Raise the price to $12?', 'Renew the domain?', 'Which plan?', 'Cancel the subscription?', 'Pay the invoice?', 'Spend the money?', 'Is $5 ok?'],
      engineering: ['Merge PR #12?', 'CI is red, retry?', 'Deploy tonight?', 'Fix this bug first?', 'Skip the flaky test?', 'Cut a release?'],
      marketing: ['Post it on Reddit?', 'Submit to HN?', 'Send the newsletter?', 'Tweet the launch?', 'Share on X?', 'Update the Changelog page?'],
      outreach: ['Someone replied, answer them?', 'She responded to the pitch; follow up?', 'A LinkedIn message came in: take the call?', 'An email from Acme: accept?', 'Answer the DM?', 'More outreach this week?', 'An inbound lead: call?'],
      admin: ['Log in to Stripe for me?', 'The token expired; rotate it?', 'Make an account on Fly?', 'Grant access to the repo?', 'Where are the credentials?', 'Finish the setup?', 'Install Docker?'],
      product: ['Add the feature?', 'Which design?', 'Is the UX right?', 'Change the roadmap?', 'Which direction?'],
      other: ['What do you think?', 'Hello?', ''],
    };
    for (const [t, texts] of Object.entries(cases)) for (const text of texts) expect([text, questionType(undefined, text)]).toEqual([text, t]);
    // Outreach beats marketing: a reply to a post.
    expect(questionType(undefined, 'Someone replied to our Reddit post: answer?')).toBe('outreach');
    // First match wins: money before a PR.
    expect(questionType(null, 'Merge the PR that changes the price?')).toBe('finance');
    // X the platform, not a lowercase x.
    for (const text of ['Option x or y?', 'Retry 5 x 2?']) expect([text, questionType(undefined, text)]).toEqual([text, 'other']);
    // Words, not parts of words.
    expect(questionType(undefined, 'Is the postgres move fine?')).toBe('other');
  });

  it('is in the MCP schema, reaches notifyOwner, is kept on the item and its bubble, and old items get one once, saved', async () => {
    expect(NOTIFY_OWNER_TOOL.inputSchema.properties.type.enum).toEqual(QUESTION_TYPES);
    expect(NOTIFY_OWNER_TOOL.description).toMatch(/Pass type/);
    const notify = vi.fn(async () => ({ ok: true, n: 1 }));
    await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify_owner', arguments: { text: 'Merge?', type: 'engineering' } } },
      { session: { isBillion: true }, notifyOwner: notify });
    expect(notify).toHaveBeenCalledWith('Merge?', expect.objectContaining({ type: 'engineering' }));

    await ask('Merge the PR?');
    await ask('Name?', { type: 'Product' });
    await ask('Name?', { type: 'legal' });
    expect(waitingPayload().items.map(i => i.type)).toEqual(['engineering', 'product', 'other']);
    expect(chatMessages().filter(m => m.q).slice(-3).map(m => m.q.type)).toEqual(['engineering', 'product', 'other']);

    const file = join(CONFIG_DIR, 'waiting.json');
    writeFileSync(file, JSON.stringify([{ id: 'old', n: 1, text: 'Renew the domain?', at: '2026-01-01T00:00:00Z', status: 'open' }]));
    expect(waitingItems()[0].type).toBe('finance');
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].type).toBe('finance');

    // A stored type stands; the file is rewritten only while one lacks it.
    writeFileSync(file, JSON.stringify([
      { id: 'a', n: 1, text: 'Renew the domain?', at: '2026-01-01T00:00:00Z', status: 'open', type: 'admin' },
      { id: 'b', n: 2, text: 'Merge the PR?', at: '2026-01-01T00:00:00Z', status: 'open' },
    ]));
    expect(waitingItems().map(i => i.type)).toEqual(['admin', 'engineering']);
    expect(JSON.parse(readFileSync(file, 'utf8')).map(i => i.type)).toEqual(['admin', 'engineering']);
    const typed = JSON.stringify([{ id: 'c', text: 'Renew the domain?', type: 'admin' }]);
    writeFileSync(file, typed);
    expect(waitingItems()[0]).toMatchObject({ type: 'admin', n: 1, status: 'open' });
    expect(readFileSync(file, 'utf8')).toBe(typed);   // all typed: read, not rewritten
    // A save that fails (a directory where its temp file goes) still reads, typed.
    writeFileSync(file, JSON.stringify([{ id: 'd', text: 'Merge the PR?' }]));
    mkdirSync(`${file}.tmp`);
    try {
      expect(waitingItems()[0].type).toBe('engineering');
      expect(JSON.parse(readFileSync(file, 'utf8'))[0].type).toBeUndefined();
    } finally { rmSync(`${file}.tmp`, { recursive: true, force: true }); }
  });
});
