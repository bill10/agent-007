// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { patchChildren, atBottom, rev } from '../public/modules/dom-patch.js';

const item = (key, text) => {
  const el = document.createElement('div');
  el.dataset.key = key;
  el.textContent = text;
  return el;
};

describe('patchChildren', () => {
  it('keeps an unchanged item as the same node and swaps a changed one in place', () => {
    const list = document.createElement('div');
    patchChildren(list, [item('a', 'one'), item('b', 'two'), item('c', 'three')]);
    const [a, b, c] = list.children;
    patchChildren(list, [item('a', 'one'), item('b', 'TWO'), item('c', 'three')]);
    expect(list.children[0]).toBe(a);
    expect(list.children[1]).not.toBe(b);
    expect(list.children[1].textContent).toBe('TWO');
    expect(list.children[2]).toBe(c);
  });

  it('adds, removes and reorders by key', () => {
    const list = document.createElement('div');
    patchChildren(list, [item('a', '1'), item('b', '2'), item('c', '3')]);
    const [a, , c] = list.children;
    patchChildren(list, [item('c', '3'), item('d', '4'), item('a', '1')]);
    expect([...list.children].map(n => n.dataset.key)).toEqual(['c', 'd', 'a']);
    expect(list.children[0]).toBe(c);
    expect(list.children[2]).toBe(a);
  });

  it('never empties the list, so the scroller keeps its scroll position', () => {
    const list = document.createElement('div');
    document.body.appendChild(list);
    patchChildren(list, [item('a', '1'), item('b', '2')]);
    // A list that is emptied at any point is clamped to scrollTop 0 by the
    // browser; watch for that moment rather than rely on layout here.
    let emptied = false;
    new MutationObserver(() => { if (!list.children.length) emptied = true; })
      .observe(list, { childList: true });
    list.scrollTop = 120;
    patchChildren(list, [item('a', '1'), item('b', 'changed'), item('c', '3')]);
    expect(emptied).toBe(false);
    expect(list.scrollTop).toBe(120);
    list.remove();
  });

  it('carries focus into an item that was replaced', () => {
    const list = document.createElement('div');
    document.body.appendChild(list);
    const card = (text) => {
      const el = item('a', '');
      const b = document.createElement('button');
      b.textContent = text;
      el.appendChild(b);
      return el;
    };
    patchChildren(list, [card('Edit')]);
    list.querySelector('button').focus();
    patchChildren(list, [card('Edit again')]);
    expect(document.activeElement).toBe(list.querySelector('button'));
    expect(document.activeElement.textContent).toBe('Edit again');
    list.remove();
  });

  it('drops unkeyed leftovers from an earlier innerHTML render', () => {
    const list = document.createElement('div');
    list.innerHTML = 'stale text<p>old</p>';
    patchChildren(list, [item('a', '1')]);
    expect(list.childNodes.length).toBe(1);
    expect(list.firstChild.dataset.key).toBe('a');
  });
});

describe('atBottom: the thread follows new messages only when the reader is at the end', () => {
  const box = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });
  it('is at the bottom within 40px of the end', () => {
    expect(atBottom(box(1000, 600, 400))).toBe(true);
    expect(atBottom(box(1000, 570, 400))).toBe(true);
  });
  it('is not when the reader has scrolled up', () => {
    expect(atBottom(box(1000, 500, 400))).toBe(false);
    expect(atBottom(box(1000, 0, 400))).toBe(false);
  });
});

describe('rev', () => {
  it('is stable for equal records and differs when a field changes', () => {
    expect(rev({ a: 1, b: 'x' })).toBe(rev({ a: 1, b: 'x' }));
    expect(rev({ a: 1, b: 'x' })).not.toBe(rev({ a: 1, b: 'y' }));
  });
});
