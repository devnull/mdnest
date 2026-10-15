// MarpDeck — renders a Marp-format note as a paginated slide deck.
//
// Each slide is displayed inside a fully **sandboxed iframe** (`sandbox=""`: no
// scripts, no same-origin, opaque origin) — that is the security boundary, so no
// markup in the note can run script or reach the app. Because of the sandbox we
// can safely enable inline HTML (`html: true`) — Marp decks commonly use
// <div class="…"> layouts and <style> blocks — and we keep `script: false` so
// Marp injects no runtime of its own. The engine is imported here so it only
// loads when a Marp note is opened with the feature enabled (the parent
// lazy-loads this component).
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Marp } from '@marp-team/marp-core';
import { slideStarts } from '../marp.js';
import { cachedThemes, loadThemes } from '../marpThemes.js';
import { exportHtml } from '../marpExport.js';
import './MarpDeck.css';

// The theme catalog lives in marpThemes.js, which does not import Marp. It
// is re-exported here for the new-deck dialog, which loads this module anyway.
export { loadThemes };

// builtinThemeCss returns the stylesheet of each of Marp's built-in themes,
// by name. The new-deck dialog reads the slide classes each theme defines.
export function builtinThemeCss(names) {
  const set = new Marp().themeSet;
  return Object.fromEntries(names.map((n) => [n, set.get(n)?.css || '']));
}

// makeEngine returns a Marp engine with the centralized themes registered, so
// a deck can select one with `theme: <name>` instead of embedding a per-deck
// style block. It is built once per theme list and reused for every render:
// building it (and registering the themes) was half the cost of a render, and
// a render keeps nothing from the previous one (a deck's own style and
// directives apply to that render only).
function makeEngine(themes) {
  const marp = new Marp({ html: true, script: false });
  for (const t of themes || []) {
    try { marp.themeSet.add(t.css); } catch { /* skip a malformed theme */ }
  }
  return marp;
}

// render turns the note into per-slide HTML fragments, the theme CSS, and the
// slide's width / height (from the slide's viewBox: 16:9 unless the deck sets
// `size`), so the frame can take the deck's own shape.
function render(content, marp) {
  const { html, css } = marp.render(content);
  // Marp emits one <svg data-marpit-svg> per slide inside a .marpit wrapper.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('svg[data-marpit-svg]');
  const slides = Array.from(nodes).map((n) => n.outerHTML);
  const [, , w, h] = (nodes[0]?.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const ratio = w > 0 && h > 0 ? w / h : 16 / 9;
  return { slides: slides.length ? slides : [html], css, ratio };
}

// slideStarts returns, from Marp source, the 0-based source line at which each
// slide begins, plus the total line count. It powers scroll-sync: an even
// scrollPct → slide split breaks the moment content isn't evenly distributed —
// a large YAML frontmatter with a `style:` block, or one long slide, throws the
// mapping off. Instead we anchor to where slides *actually* begin;
// see marp.js for the exact rules.

// exportable: false hides the HTML export (the new-deck preview has no note yet).
export default function MarpDeck({ content, scrollPct, caret, title, exportable = true }) {
  // Centralized themes load asynchronously; until then we render with the
  // built-in themes only (a deck that selects a custom theme falls back to
  // `default` for one frame, then re-renders once the catalog arrives).
  const [themes, setThemes] = useState(() => cachedThemes() || []);
  useEffect(() => {
    let cancelled = false;
    loadThemes().then((t) => { if (!cancelled) setThemes(t); });
    return () => { cancelled = true; };
  }, []);

  const engine = useMemo(() => makeEngine(themes), [themes]);
  const { slides, css, ratio, error } = useMemo(() => {
    try {
      return render(content, engine);
    } catch (e) {
      return { slides: [], css: '', error: e.message };
    }
  }, [content, engine]);

  const total = slides.length;
  const [idx, setIdx] = useState(0);
  const clamp = useCallback((i) => Math.max(0, Math.min(total - 1, i)), [total]);
  useEffect(() => { setIdx((i) => clamp(i)); }, [total, clamp]);

  // Source line where each slide begins, used to map the editor position to a
  // slide by *where the breaks really are* rather than an even split.
  const { starts, totalLines } = useMemo(() => slideStarts(content), [content]);

  // In split view the deck follows the editor. The parent hands us two
  // signals: the editor's 0..1 scroll ratio, and the caret's source line.
  // Each maps to the slide whose range of source lines contains it (anchored
  // to where slides really begin, so a huge frontmatter or an uneven slide
  // does not throw it off). Whichever moved last wins: the caret while you
  // type or click, the scroll ratio when you only scroll. Both effects react
  // to their own signal only, never to a content change, so editing a slide
  // does not pull the deck to a stale scroll position, and a slide picked
  // with the buttons stays until the caret or the scroll moves again.
  // Ignored when the parent passes nothing (fullscreen, mobile, preview-only).
  const layoutRef = useRef({ starts, totalLines, total });
  layoutRef.current = { starts, totalLines, total };
  const slideAt = useCallback((line) => {
    const { starts: st } = layoutRef.current;
    let s = 0;
    while (s + 1 < st.length && st[s + 1] <= line) s++;
    return s;
  }, []);

  useEffect(() => {
    const { totalLines: n, total: t } = layoutRef.current;
    if (typeof scrollPct !== 'number' || t <= 1) return;
    setIdx(Math.min(t - 1, slideAt(scrollPct * Math.max(0, n - 1))));
  }, [scrollPct, title, slideAt]);

  useEffect(() => {
    const { total: t } = layoutRef.current;
    if (!caret || t <= 1) return;
    setIdx(Math.min(t - 1, slideAt(caret.line)));
  }, [caret, slideAt]);

  const rootRef = useRef(null);
  const go = useCallback((delta) => setIdx((i) => clamp(i + delta)), [clamp]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'Home') { e.preventDefault(); setIdx(0); }
      else if (e.key === 'End') { e.preventDefault(); setIdx(total - 1); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [go, total]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }, []);

  const [exporting, setExporting] = useState('');
  const doExport = useCallback(async () => {
    if (exporting) return;
    setExporting('html');
    try {
      await exportHtml(content, themes, title);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Marp export failed:', e);
    } finally {
      setExporting('');
    }
  }, [content, themes, title, exporting]);

  const srcDoc = useMemo(() => {
    if (!total) return '';
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<style>${css}\nhtml,body{margin:0;height:100%}`
      + `body{display:flex;align-items:center;justify-content:center;background:#0b0b12}`
      // The frame takes the deck's ratio (--deck-ratio); the SVG still keeps
      // its own (preserveAspectRatio), so a rounding pixel never crops it.
      + `.marpit{width:100%;height:100%}svg[data-marpit-svg]{display:block;width:100%;height:100%}</style>`
      + `</head><body><div class="marpit">${slides[idx]}</div></body></html>`;
  }, [slides, css, idx, total]);

  if (error || !total) {
    return <div className="marp-deck-empty">Could not render this Marp deck{error ? `: ${error}` : ''}.</div>;
  }

  return (
    <div className="marp-deck" ref={rootRef} tabIndex={0} style={{ '--deck-ratio': ratio }}>
      <div className="marp-deck-stage">
        <iframe
          className="marp-deck-frame"
          title="Marp slide"
          sandbox=""
          srcDoc={srcDoc}
        />
      </div>
      <div className="marp-deck-controls">
        <button type="button" onClick={() => go(-1)} disabled={idx === 0} aria-label="Previous slide">‹</button>
        <span className="marp-deck-counter">{idx + 1} / {total}</span>
        <button type="button" onClick={() => go(1)} disabled={idx === total - 1} aria-label="Next slide">›</button>
        {exportable && <button type="button" className="marp-deck-export" onClick={() => doExport()} disabled={!!exporting} title="Export as a standalone Marp presentation (navigation, fullscreen, presenter)">{exporting ? '…' : 'HTML'}</button>}
        <button type="button" className="marp-deck-fs" onClick={toggleFullscreen} aria-label="Toggle fullscreen">⛶</button>
      </div>
    </div>
  );
}
