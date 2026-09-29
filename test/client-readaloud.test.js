// @vitest-environment happy-dom
// Read aloud (public/modules/readaloud.js): the text a message is read as
// (markdown stripped, URLs as "link", Q51 as "question 51", a question's
// choices at the end), cutting it into pieces short enough for Chrome, the
// voice picked, and the speaker: one message at a time, tap again to stop,
// auto-read queued and waiting for a tap after a reload.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  plainForSpeech, speakableText, chunkForSpeech, pickVoice, englishVoices,
  toggleSpeak, readNew, stopReading, setAutoRead, resumeReading, autoReadOn,
  needsResume, speakingMessage, queuedCount, _resetReadAloud,
} from '../public/modules/readaloud.js';

describe('plainForSpeech', () => {
  it('strips markdown emphasis, headings, bullets, quotes and inline code', () => {
    expect(plainForSpeech('## Status\n- **PR 12** is _green_\n> merged `main`'))
      .toBe('Status. PR 12 is green. merged main.');
  });

  it('reads URLs as "link" and markdown links as their text', () => {
    expect(plainForSpeech('See https://github.com/x/y/pull/3 and [the docs](https://example.com/a).'))
      .toBe('See link and the docs.');
    expect(plainForSpeech('<https://a.b/c> or www.example.com')).toBe('link or link.');
  });

  it('expands Q-numbers and #-numbers', () => {
    expect(plainForSpeech('Q51 is about #160.')).toBe('question 51 is about number 160.');
    expect(plainForSpeech('FAQ5 stays')).toBe('FAQ5 stays.');
  });

  it('replaces a fenced code block instead of reading it', () => {
    expect(plainForSpeech('Run this:\n```\nnpm test\n```\nthen tell me')).toBe('Run this: (code block). then tell me.');
  });

  it('leaves snake_case and file paths alone', () => {
    expect(plainForSpeech('set my_var_name in lib/jobs.js')).toBe('set my_var_name in lib/jobs.js.');
  });

  it('handles empty and missing text', () => {
    expect(plainForSpeech('')).toBe('');
    expect(plainForSpeech(undefined)).toBe('');
  });
});

describe('speakableText', () => {
  const q = (extra = {}) => ({ id: 'm1', from: 'billion', text: 'Ship **PR 3**?', q: { id: 'w1', n: 51, status: 'open', choices: ['Not yet', 'Done'], recommended: 'Done', ...extra } });

  it('reads a plain message as its text', () => {
    expect(speakableText({ from: 'billion', text: 'All green. See https://x.y' })).toBe('All green. See link.');
  });

  it('reads an open question with its number and its choices last', () => {
    expect(speakableText(q())).toBe('Question 51. Ship PR 3? Choices: Not yet, Done; recommended: Done.');
  });

  it('leaves the choices out once the question is closed, and the recommendation when there is none', () => {
    expect(speakableText(q({ status: 'answered' }))).toBe('Question 51. Ship PR 3?');
    expect(speakableText(q({ recommended: undefined }))).toBe('Question 51. Ship PR 3? Choices: Not yet, Done.');
  });
});

describe('chunkForSpeech', () => {
  it('keeps short text in one piece and drops blank text', () => {
    expect(chunkForSpeech('Hello there. How are you?')).toEqual(['Hello there. How are you?']);
    expect(chunkForSpeech('  ')).toEqual([]);
  });

  it('splits on sentence ends and packs sentences up to the limit', () => {
    const chunks = chunkForSpeech('One two. Three four. Five six.', 20);
    expect(chunks).toEqual(['One two. Three four.', 'Five six.']);
  });

  it('never returns a piece over the limit, splitting at commas, then spaces, then inside a word', () => {
    const long = `${'word, '.repeat(30)}${'x'.repeat(50)} end.`;
    const chunks = chunkForSpeech(long, 40);
    expect(chunks.every(c => c.length <= 40)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''));
  });

  it('cuts a long message into pieces under the default limit', () => {
    const text = 'This is a sentence that goes on for a while. '.repeat(20);
    const chunks = chunkForSpeech(text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every(c => c.length <= 180)).toBe(true);
  });
});

describe('pickVoice', () => {
  const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: `uri:${name}`, ...extra });
  const voices = [v('Thomas', 'fr-FR'), v('Daniel', 'en-GB'), v('Fred', 'en-US', { default: true }), v('Ava (Premium)', 'en-US'), v('Google UK English', 'en-GB')];

  it('prefers en-US high-quality voices', () => {
    expect(pickVoice(voices).name).toBe('Ava (Premium)');
    expect(pickVoice([v('Daniel', 'en-GB'), v('Google US English', 'en-US'), v('Fred', 'en-US')]).name).toBe('Google US English');
  });

  it('takes the saved voice while it is installed', () => {
    expect(pickVoice(voices, 'uri:Daniel').name).toBe('Daniel');
    expect(pickVoice(voices, 'uri:gone').name).toBe('Ava (Premium)');
  });

  it('falls back to any voice when none is English, and null when there are none', () => {
    expect(pickVoice([v('Thomas', 'fr-FR')]).name).toBe('Thomas');
    expect(pickVoice([])).toBeNull();
  });

  it('lists only English voices, by name', () => {
    expect(englishVoices(voices).map(x => x.name)).toEqual(['Ava (Premium)', 'Daniel', 'Fred', 'Google UK English']);
  });
});

describe('the speaker', () => {
  let spoken;
  beforeEach(() => {
    spoken = [];
    localStorage.clear();
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = {
      speak: vi.fn(u => spoken.push(u)),
      cancel: vi.fn(() => { spoken = []; }),
      resume: vi.fn(),
      getVoices: () => [{ name: 'Ava (Premium)', lang: 'en-US', voiceURI: 'ava' }],
    };
    _resetReadAloud();
  });
  const endAll = () => { const last = spoken.at(-1); last.onend?.(); };

  it('speaks a message in pieces with the best voice, and a second tap stops it', () => {
    toggleSpeak('m1', 'First sentence. '.repeat(30));
    expect(speakingMessage()).toBe('m1');
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken[0].voice.name).toBe('Ava (Premium)');
    toggleSpeak('m1', 'ignored');
    expect(speakingMessage()).toBeNull();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  it('tapping another message stops the first and speaks the second', () => {
    toggleSpeak('m1', 'One.');
    toggleSpeak('m2', 'Two.');
    expect(speakingMessage()).toBe('m2');
    expect(spoken.map(u => u.text)).toEqual(['Two.']);
  });

  it('is done when the last piece ends', () => {
    toggleSpeak('m1', 'One.');
    endAll();
    expect(speakingMessage()).toBeNull();
  });

  it('auto-read is off by default and new messages are not spoken', () => {
    expect(autoReadOn()).toBe(false);
    readNew('m1', 'Hello.');
    expect(spoken).toEqual([]);
  });

  it('with auto-read on, new messages are queued and spoken one after another', () => {
    setAutoRead(true);
    expect(localStorage.getItem('agent007-read-aloud')).toBe('1');
    expect(speakingMessage()).toBe('__auto__');   // the confirmation, spoken inside the tap
    readNew('m1', 'First.');
    readNew('m2', 'Second.');
    readNew('m2', 'Second.');                       // the same message is queued once
    expect(queuedCount()).toBe(2);
    endAll();
    expect(speakingMessage()).toBe('m1');
    endAll();
    expect(speakingMessage()).toBe('m2');
    endAll();
    expect([speakingMessage(), queuedCount()]).toEqual([null, 0]);
  });

  it('a speech error moves on to the next message', () => {
    setAutoRead(true);
    readNew('m1', 'First.');
    readNew('m2', 'Second.');
    endAll();
    spoken.at(-1).onerror({ error: 'synthesis-failed' });
    expect(speakingMessage()).toBe('m2');
  });

  it('after a reload, auto-read waits for one tap on Resume reading', () => {
    localStorage.setItem('agent007-read-aloud', '1');
    expect(needsResume()).toBe(true);
    readNew('m1', 'First.');
    expect(spoken).toEqual([]);
    expect(queuedCount()).toBe(1);
    resumeReading();
    expect(needsResume()).toBe(false);
    expect(speakingMessage()).toBe('m1');
  });

  it('turning auto-read off stops reading and forgets the setting', () => {
    setAutoRead(true);
    readNew('m1', 'First.');
    setAutoRead(false);
    expect([speakingMessage(), queuedCount(), localStorage.getItem('agent007-read-aloud')]).toEqual([null, 0, null]);
  });

  it('stopReading drops the queue', () => {
    setAutoRead(true);
    readNew('m1', 'First.');
    stopReading();
    expect([speakingMessage(), queuedCount()]).toEqual([null, 0]);
  });
});
