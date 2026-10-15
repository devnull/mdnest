// @vitest-environment jsdom
//
// How much work the "+ Slides" dialog does while someone types. The preview
// is the Marp deck viewer, and a Marp render of a whole deck is the expensive
// part, so the dialog must not hand the preview a new deck per keystroke, and
// must not rebuild the deck on a render where nothing in it changed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const { counts, deckModule } = vi.hoisted(() => {
  const counts = { build: 0, previews: [] };
  // Stands in for MarpDeck.jsx: records each deck the preview is handed.
  const deckModule = {
    default: ({ content }) => { counts.previews.push(content); return null; },
    loadThemes: () => Promise.resolve([{
      name: 'acme',
      css: '/* @theme acme */\nsection.cover {}\nsection.light {}\nsection.dark {}',
      templates: '---\nmarp: true\nclass: light\nfooter: Acme\n---\n\n<!-- _class: cover -->\n\n# Title\n\n---\n\n## Content',
    }]),
    builtinThemeCss: (names) => Object.fromEntries(names.map((n) => [n, ''])),
  };
  return { counts, deckModule };
});


vi.mock('../newDeck.js', async (orig) => {
  const real = await orig();
  return { ...real, buildDeck: (...a) => { counts.build++; return real.buildDeck(...a); } };
});

vi.mock('../api.js', () => ({ createNoteWithContent: vi.fn() }));

// The dialog loads the deck viewer through loadWithRetry; hand it the stand-in.
vi.mock('../lazyWithRetry.js', () => ({ loadWithRetry: () => Promise.resolve(deckModule) }));

const { default: NewDeckModal } = await import('../components/NewDeckModal.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function type(input, value) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Lets the lazy preview resolve and any pending preview delay run out.
const settle = () => act(() => new Promise((r) => setTimeout(r, 400)));

let root;
let host;

beforeEach(async () => {
  counts.build = 0;
  counts.previews = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<NewDeckModal namespace="ns" dir="" onClose={() => {}} onCreated={() => {}} />);
  });
  // The catalog loads, the theme is picked, and the lazy preview resolves.
  for (let i = 0; i < 5; i++) {
    await settle();
  }
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('NewDeckModal render work', () => {
  it('starts from the catalog theme with a preview', () => {
    expect(host.querySelector('[data-testid=new-deck-theme]').value).toBe('acme');
    expect(counts.previews.length).toBeGreaterThan(0);
  });

  it('sends the preview one deck for a burst of typing, not one per key', async () => {
    const input = host.querySelector('[data-testid=new-deck-name]');
    const before = new Set(counts.previews).size;
    const built = counts.build;
    const word = 'quarterly-review';
    for (let i = 1; i <= word.length; i++) {
      await act(async () => { type(input, word.slice(0, i)); });
    }
    await settle();
    const distinct = new Set(counts.previews).size - before;
    expect(distinct).toBe(1);
    // The deck is built for the preview once; Create builds its own.
    expect(counts.build - built).toBe(1);
    expect(counts.previews.at(-1)).toContain('# Quarterly review');
  });

  it('does not rebuild the deck when the typed text comes back unchanged', async () => {
    const input = host.querySelector('[data-testid=new-deck-name]');
    await act(async () => { type(input, 'deck'); });
    await settle();
    const built = counts.build;
    // "deck " has the same title as "deck", so the deck is the same.
    await act(async () => { type(input, 'deck '); });
    await act(async () => { type(input, 'deck'); });
    await settle();
    expect(counts.build - built).toBe(0);
  });

  it('shows a new theme at once, with its own footer', async () => {
    const select = host.querySelector('[data-testid=new-deck-theme]');
    const seen = counts.previews.length;
    await act(async () => {
      select.value = 'gaia';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const decks = counts.previews.slice(seen);
    expect(decks.length).toBeGreaterThan(0);
    // No frame of the new theme with the old theme's footer, and no second
    // deck when the typing delay runs out.
    expect(decks.every((d) => d.includes('theme: gaia') && !d.includes('footer:'))).toBe(true);
    await settle();
    expect(new Set(counts.previews.slice(seen)).size).toBe(1);
  });
});
