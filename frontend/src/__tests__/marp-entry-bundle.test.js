// What the first page load carries. Everything reachable from main.jsx by
// STATIC imports lands in the entry bundle, which every user downloads before
// the app draws anything. Heavy libraries used by one feature must come in
// through a dynamic import() instead.
//
// This bit twice in the same way: AdminPanel imported clearMarpThemeCache
// from MarpDeck.jsx, which pulled all of marp-core (~3.6 MB raw) into the
// entry, and App imported the Firebase SDK that only Firebase-mode servers
// use. The walk below follows static imports only, the way the bundler
// decides what goes in the entry chunk.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// Packages that must never be in the entry bundle.
const LAZY_ONLY = [/^@marp-team\//, /^firebase(\/|$)/];

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function resolveLocal(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const p of [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js')]) {
    if (existsSync(p) && /\.jsx?$/.test(p)) return p;
  }
  return null;
}

// Returns [{ file, pkg }] for every forbidden package reachable from entry.
function entryOffenders(entry) {
  const seen = new Set();
  const out = [];
  const walk = (file, via) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(STATIC_IMPORT)) {
      const spec = m[1];
      const rel = file.slice(SRC.length + 1);
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next) walk(next, [...via, rel]);
      } else if (LAZY_ONLY.some((re) => re.test(spec))) {
        out.push(`${[...via, rel].join(' -> ')} imports ${spec}`);
      }
    }
  };
  walk(entry, []);
  return { offenders: out, files: seen.size };
}

describe('entry bundle', () => {
  it('statically reaches neither Marp nor the Firebase SDK', () => {
    const { offenders, files } = entryOffenders(join(SRC, 'main.jsx'));
    expect(files).toBeGreaterThan(20); // the walk really followed App's imports
    expect(offenders).toEqual([]);
  });

  it('would notice a static import of the deck viewer', () => {
    // The walk itself, against a module that is supposed to carry Marp.
    const { offenders } = entryOffenders(join(SRC, 'components', 'MarpDeck.jsx'));
    expect(offenders.join('\n')).toMatch(/@marp-team\/marp-core/);
  });
});
