// @vitest-environment happy-dom
// Settings' "Read aloud" row (public/modules/settings.js renderVoiceSettings):
// the voice the Billion tab reads in, picked here and remembered by the browser.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../public/modules/ws.js', () => ({ send: vi.fn(() => true) }));
import { renderVoiceSettings } from '../public/modules/settings.js';
import { savedVoiceURI } from '../public/modules/readaloud.js';

const html = readFileSync('public/index.html', 'utf8');
const section = html.match(/<div class="voice-settings"[\s\S]*?<\/div>\s*<\/div>/)[0];
const voices = (...names) => names.map((name, i) => ({ name, lang: 'en-US', voiceURI: `v${i}`, localService: true }));
const box = () => document.getElementById('voice-settings');
const pick = () => document.getElementById('voice-pick');

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = `<div id="settings-panel">${section}</div>`;
  window.SpeechSynthesisUtterance = class {};
  window.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] };
});

describe('the Settings voice row', () => {
  it('sits in the Settings window under "Read aloud", a select labelled "Voice for reading messages aloud" that is no login field', () => {
    expect(html.indexOf('id="voice-settings"')).toBeGreaterThan(html.indexOf('id="settings-panel"'));
    expect(html.indexOf('id="voice-settings"')).toBeLessThan(html.indexOf('id="theme-toggle"'));
    expect(box().querySelector('h2').textContent).toBe('Read aloud');
    expect(pick().closest('label').textContent).toBe('Voice for reading messages aloud');
    expect(pick().getAttribute('autocomplete')).toBe('off');
    const css = readFileSync('public/style.css', 'utf8');
    expect(css).toMatch(/@media \(max-width: 700px\) \{ \.settings-voice-pick \{ font-size: 16px;/);
  });

  it('shows only when the browser offers a choice of voices', () => {
    renderVoiceSettings();
    expect(box().hidden).toBe(true);
    window.speechSynthesis.getVoices = () => voices('Albert');
    renderVoiceSettings();
    expect(box().hidden).toBe(true);
    window.speechSynthesis.getVoices = () => voices('Albert', 'Samantha');
    renderVoiceSettings();
    expect(box().hidden).toBe(false);
    delete window.speechSynthesis;
    renderVoiceSettings();
    expect(box().hidden).toBe(true);
  });

  it('offers "Auto · <voice>" then each voice, and remembers the pick across a reload', () => {
    window.speechSynthesis.getVoices = () => voices('Albert', 'Samantha');
    renderVoiceSettings();
    expect([...pick().options].map(o => [o.value, o.textContent])).toEqual([['', expect.stringMatching(/^Auto · /)], ['v0', 'Albert'], ['v1', 'Samantha']]);
    expect(pick().value).toBe('');
    pick().value = 'v1';
    pick().onchange();
    expect(savedVoiceURI()).toBe('v1');
    document.body.innerHTML = `<div id="settings-panel">${section}</div>`;
    renderVoiceSettings();
    expect(pick().value).toBe('v1');
    pick().value = '';
    pick().onchange();
    expect(savedVoiceURI()).toBeNull();
  });
});
