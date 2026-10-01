// Keyed list updates that keep the reader's place. The board and the Billion
// tab redraw on every broadcast and on a slow clock tick; emptying a scroller
// and filling it again drops its scrollTop to 0 (the browser clamps it while
// the scroller is empty), which threw the owner back to the top of To do while
// they were reading further down. patchChildren updates a list in place
// instead: the scroller itself is never emptied, an item that looks the same
// is kept as it is, and one that changed is swapped where it stands with its
// own inner scroll and focus carried across.

// Within this many px of the end counts as "at the bottom": the thread follows
// new messages only then, and otherwise leaves the reader where they are.
export const BOTTOM_SLACK = 40;

export function atBottom(el, slack = BOTTOM_SLACK) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

// What a replaced item had going on: the scroll of every descendant that was
// scrolled (by its index in document order) and which one had focus.
function snapshot(el) {
  const all = [el, ...el.querySelectorAll('*')];
  const scrolled = [];
  all.forEach((node, i) => {
    if (node.scrollTop || node.scrollLeft) scrolled.push([i, node.tagName, node.scrollTop, node.scrollLeft]);
  });
  const active = document.activeElement;
  const focus = active && el.contains(active) ? all.indexOf(active) : -1;
  return { scrolled, focus };
}

function restore(el, { scrolled, focus }) {
  if (!scrolled.length && focus < 0) return;
  const all = [el, ...el.querySelectorAll('*')];
  for (const [i, tag, top, left] of scrolled) {
    const node = all[i];
    if (node?.tagName !== tag) continue;
    node.scrollTop = top;
    node.scrollLeft = left;
  }
  if (focus >= 0) all[focus]?.focus?.({ preventScroll: true });
}

// Makes `parent`'s element children the `next` nodes, in order, each keyed by
// its data-key. An old child with the same key that isEqualNode the new one is
// kept (so its own state: scroll, focus, a running animation, a text
// selection, survives); one that differs is replaced in place. Children with
// no data-key are treated as always new. Returns the nodes now in the list.
//
// A kept node keeps its own event handlers, so a renderer using this must put
// everything those handlers depend on into the markup (a card's data-rev),
// or two renders that differ only in a closure would look the same.
export function patchChildren(parent, next) {
  const old = new Map();
  for (const child of parent.children) {
    const key = child.dataset?.key;
    if (key != null && !old.has(key)) old.set(key, child);
  }
  const placed = next.map((node) => {
    const key = node.dataset?.key;
    const prev = key != null ? old.get(key) : null;
    if (!prev) return { node };
    old.delete(key);
    if (prev.isEqualNode(node)) return { node: prev };
    return { node, prev, state: snapshot(prev) };
  });
  const keep = new Set(placed.map(p => p.node));
  for (const p of placed) if (p.prev) { p.prev.replaceWith(p.node); keep.add(p.node); }
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  // Text nodes left from an earlier innerHTML render go too.
  for (const child of [...parent.childNodes]) if (child.nodeType !== 1) child.remove();
  placed.forEach(({ node }, i) => {
    const at = parent.children[i];
    if (at !== node) parent.insertBefore(node, at || null);
  });
  for (const p of placed) if (p.state) restore(p.node, p.state);
  return placed.map(p => p.node);
}

// A short stable fingerprint of a record, for a data-rev attribute: two cards
// whose records differ never compare equal, even where the markup would.
export function rev(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
