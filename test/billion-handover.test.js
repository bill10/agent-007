// HANDOVER.md (server/billion-handover.js): the end of the old CLI's
// conversation as plain text, read from sample transcripts, never real ones.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { transcriptMessages, handoverText, writeHandover, HANDOVER_CHARS } from '../server/billion-handover.js';

const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', 'billion-transcripts', name), 'utf8');
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

describe('transcriptMessages', () => {
  it('skips malformed blocks without losing valid conversation text', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [null, 42, {}, { type: 'text', text: 'Resume safely' }] } });
    expect(transcriptMessages('claude', `invalid json\n${line}`)).toEqual([{ role: 'assistant', text: 'Resume safely' }]);
  });

  it('bounds large tool histories and preserves the newest result and both ends of long content', () => {
    const lines = Array.from({ length: 80 }, (_, i) => JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: `call-${i}`, output: `START-${i} ` + 'x'.repeat(20000) + ` END-${i}`,
    } })).join('\n');
    const out = transcriptMessages('codex', lines);
    expect(out.length).toBeLessThan(80);
    expect(out.reduce((sum, m) => sum + m.text.length, 0)).toBeLessThanOrEqual(HANDOVER_CHARS);
    expect(out.at(-1).text).toContain('START-79');
    expect(out.at(-1).text).toContain('END-79');
    expect(out.at(-1).text).toContain('middle omitted');
  });

  it('exports custom Codex calls and results but excludes private reasoning', () => {
    const lines = [
      { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: 'patch content' },
      { type: 'custom_tool_call_output', call_id: 'c1', output: { success: true } },
      { type: 'reasoning', content: 'private' },
    ].map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n');
    expect(transcriptMessages('codex', lines)).toEqual([
      { role: 'tool', text: 'Tool call c1: apply_patch\npatch content' },
      { role: 'tool', text: 'Tool result c1:\n{"success":true}' },
    ]);
  });

  it('keeps what the owner and Billion said in a Claude Code transcript, nothing else', () => {
    expect(transcriptMessages('claude', fixture('claude.jsonl'))).toEqual([
      { role: 'user', text: 'This is your first run. Introduce yourself.' },
      { role: 'assistant', text: "Hi, I'm Billion." },
      { role: 'tool', text: 'Tool call t1: Bash\n{"command":"git log"}' },
      { role: 'tool', text: 'Tool result t1:\nabc123 first run' },
      { role: 'assistant', text: "What's the mission?" },
      { role: 'user', text: 'Ship the Windows build.' },
      { role: 'assistant', text: 'Got it: the Windows build.' },
    ]);
  });

  it('keeps what was typed and answered in a Codex rollout, not its instructions', () => {
    expect(transcriptMessages('codex', fixture('codex.jsonl'))).toEqual([
      { role: 'user', text: 'Run one operating cycle as defined in CHARTER.md.' },
      { role: 'tool', text: 'Tool call : shell\n{}' },
      { role: 'assistant', text: 'Card 12 is in Review; merging #140.' },
    ]);
  });

  it('keeps only the last messages, each cut to a readable length', () => {
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({
      type: i % 2 ? 'assistant' : 'user', message: { content: i === 29 ? 'x'.repeat(20000) : `m${i}` },
    })).join('\n');
    const out = transcriptMessages('claude', lines, 20);
    expect(out).toHaveLength(20);
    expect(out[0].text).toBe('m10');
    expect(out[19].text.length).toBeLessThan(8200);
    expect(out[19].text).toContain('middle omitted');
  });
});

describe('writeHandover', () => {
  it('writes the last messages of the newest Claude Code conversation in the folder', () => {
    const dir = tmp('a007-ho-dir-');
    const claude = tmp('a007-ho-claude-');
    const project = join(claude, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'a.jsonl'), fixture('claude.jsonl'));
    const { path, messages } = writeHandover(dir, { from: 'claude', to: 'codex', homes: { claude, codex: tmp('a007-ho-codex-') }, now: new Date('2026-09-26T12:00:00Z') });
    expect(messages).toBe(7);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('when Billion moved from Claude Code to Codex');
    expect(text).toContain('Read `STATE.md` first');
    expect(text).toContain('`git log -10`');
    expect(text).toContain('> Ship the Windows build.');
    expect(text).toContain('### Billion');
    expect(text).toContain('Tool result t1');
    expect(text).not.toContain('> private');
  });

  it('finds the Codex rollout whose cwd is the folder', () => {
    const dir = tmp('a007-ho-dir-');
    const codex = tmp('a007-ho-codex-');
    const day = join(codex, 'sessions', '2026', '09', '26');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-a.jsonl'), fixture('codex.jsonl').replaceAll('CWD', JSON.stringify(dir).slice(1, -1)));
    writeFileSync(join(day, 'rollout-b.jsonl'), fixture('codex.jsonl').replaceAll('CWD', '/elsewhere').replace('merging #140', 'someone else'));
    writeHandover(dir, { from: 'codex', to: 'claude', homes: { claude: tmp('a007-ho-claude-'), codex } });
    const text = readFileSync(join(dir, 'HANDOVER.md'), 'utf8');
    expect(text).toContain('from Codex to Claude Code');
    expect(text).toContain('merging #140');
  });

  it('says so when there is no conversation to hand over', () => {
    expect(handoverText({ from: 'codex', to: 'claude', file: null, messages: [] })).toMatch(/No Codex conversation was found/);
  });
});
