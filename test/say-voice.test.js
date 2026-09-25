// Which macOS voice Billion speaks with (server/voice.js, SAY_VOICE): spawn is
// mocked, `say -v '?'` answers with tools.voices, nothing is really spoken.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';

const tools = { voices: '', calls: [] };

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn((cmd, args) => {
    tools.calls.push([cmd, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (cmd === 'say' && args[1] === '?') child.stdout.emit('data', tools.voices);
      if (cmd === 'ffmpeg') writeFileSync(args[args.length - 1], 'OGG');
      child.emit('close', 0);
    });
    return child;
  }),
}));

const LIST = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.',
  'Ava (Enhanced)      en_US    # Hello! My name is Ava.',
  'Ava (Premium)       en-US    # Hello! My name is Ava.',
  'Amélie (Premium)    fr_CA    # Bonjour! Je m’appelle Amélie.',
  'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
].join('\n');

let log;
beforeEach(() => {
  vi.resetModules();   // a fresh voice cache per test
  tools.calls = [];
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

const speak = async (voices, env) => {
  tools.voices = voices;
  const { synthesize } = await import('../server/voice.js');
  await synthesize('hello', env);
  await synthesize('again', env);
  const says = tools.calls.filter(([cmd, args]) => cmd === 'say' && args[1] !== '?');
  expect(tools.calls.filter(([, args]) => args[1] === '?')).toHaveLength(1);   // listed once, cached
  return says.map(([, args]) => args.slice(0, args.indexOf('-o')));
};

describe('SAY_VOICE and the auto-picked voice', () => {
  it('honours SAY_VOICE when it is installed', async () => {
    expect(await speak(LIST, { SAY_VOICE: 'Samantha' })).toEqual([['-v', 'Samantha'], ['-v', 'Samantha']]);
    expect(log).not.toHaveBeenCalled();
  });

  it('a bare SAY_VOICE takes that voice\'s best quality', async () => {
    expect((await speak(LIST, { SAY_VOICE: 'Ava' }))[0]).toEqual(['-v', 'Ava (Premium)']);
  });

  it('SAY_VOICE by its bare name matches the listed "Name (English (UK))"', async () => {
    expect((await speak(LIST, { SAY_VOICE: 'eddy' }))[0]).toEqual(['-v', 'Eddy (English (UK))']);
  });

  it('a missing SAY_VOICE is logged once, naming it, and falls back to the best voice', async () => {
    expect(await speak(LIST, { SAY_VOICE: 'Nobody' })).toEqual([['-v', 'Ava (Premium)'], ['-v', 'Ava (Premium)']]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('"Nobody"');
  });

  it('prefers English Premium over Enhanced over the default', async () => {
    expect((await speak(LIST, {}))[0]).toEqual(['-v', 'Ava (Premium)']);   // a hyphenated locale too
    vi.resetModules(); tools.calls = [];
    const noPremium = LIST.split('\n').filter(l => !l.startsWith('Ava (Premium)')).join('\n');
    expect((await speak(noPremium, {}))[0]).toEqual(['-v', 'Ava (Enhanced)']);
    vi.resetModules(); tools.calls = [];
    expect((await speak('Albert              en_US    # Hello!', {}))[0]).toEqual([]);
  });

  it('no voices parsed means no -v flag', async () => {
    expect(await speak('', {})).toEqual([[], []]);
  });
});
