import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The xterm light palette in terminal.js hardcodes colors that must track the
// CSS light-theme tokens in style.css — a drift makes the theme toggle look
// broken (terminal pane a different cream than the panels around it).
// DESIGN.md carries a third copy of the palette, so it is checked too.

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const termSrc = readFileSync(new URL('../public/modules/terminal.js', import.meta.url), 'utf8');
const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');

function cssBlock(selector) {
  const m = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(m, `no ${selector} block found in style.css`).toBeTruthy();
  return m[1];
}

function cssToken(name) {
  const m = cssBlock('\\[data-theme="light"\\]').match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`));
  expect(m, `token ${name} not found in the light theme block`).toBeTruthy();
  return m[1].toLowerCase();
}

function termLightValue(key) {
  // The light palette is the `? { ... }` arm of getTerminalTheme's ternary.
  const start = termSrc.indexOf('? {');
  const end = termSrc.indexOf(': {');
  expect(start > -1 && end > start, 'light-theme ternary arm not found in terminal.js').toBe(true);
  const m = termSrc.slice(start, end).match(new RegExp(`${key}: '(#[0-9a-fA-F]{3,6})'`));
  expect(m, `${key} not found in the light terminal palette`).toBeTruthy();
  return m[1].toLowerCase();
}

describe('light theme tokens stay in sync between style.css and terminal.js', () => {
  it('terminal background matches --bg-terminal', () => {
    expect(termLightValue('background')).toBe(cssToken('--bg-terminal'));
  });

  it('terminal foreground matches --text', () => {
    expect(termLightValue('foreground')).toBe(cssToken('--text'));
  });

  it('terminal cursor matches --accent', () => {
    expect(termLightValue('cursor')).toBe(cssToken('--accent'));
  });

  it('terminal selection is visible against the terminal background', () => {
    // Selection deliberately does NOT reuse a surface token: it must contrast
    // with --bg-terminal or selected text gives no feedback.
    expect(termLightValue('selectionBackground')).not.toBe(cssToken('--bg-terminal'));
  });
});

describe('light theme block covers every :root token', () => {
  it('every :root custom property has a light override', () => {
    // A token added to :root but missed here silently keeps its dark value on
    // the cream background — the exact bug class this palette retune fixed.
    const names = (block) => [...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
    const light = new Set(names(cssBlock('\\[data-theme="light"\\]')));
    for (const name of names(cssBlock(':root'))) {
      expect(light, `missing light override for ${name}`).toContain(name);
    }
  });
});

describe('DESIGN.md light palette matches style.css', () => {
  it('every token listed in the DESIGN.md light theme fence matches the CSS value', () => {
    const fence = design.match(/### Light Theme[^`]*```css\n([\s\S]*?)```/);
    expect(fence, 'light theme code fence not found in DESIGN.md').toBeTruthy();
    const entries = [...fence[1].matchAll(/(--[\w-]+):\s+(#[0-9a-fA-F]{3,6})/g)];
    expect(entries.length).toBeGreaterThan(0);
    for (const [, name, value] of entries) {
      expect(cssToken(name), `DESIGN.md drifted for ${name}`).toBe(value.toLowerCase());
    }
  });
});
