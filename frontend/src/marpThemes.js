// The central Marp theme catalog (Admin > Marp Themes), fetched once and
// shared by every deck: a global catalog, not scoped to any namespace. The
// admin theme editor calls clearMarpThemeCache() after a change so the next
// deck render picks it up.
//
// Kept out of MarpDeck.jsx on purpose: this module must not import the Marp
// engine. The admin panel needs clearMarpThemeCache and is in the entry
// bundle, so importing it from MarpDeck.jsx pulled all of marp-core into
// the first page load of every user (__tests__/marp-entry-bundle.test.js).
import { getMarpThemes } from './api.js';

let themeCache = null;
let themePromise = null;

export function clearMarpThemeCache() {
  themeCache = null;
  themePromise = null;
}

// cachedThemes returns the catalog if it has loaded, else null.
export function cachedThemes() {
  return themeCache;
}

export function loadThemes() {
  if (themeCache) return Promise.resolve(themeCache);
  if (!themePromise) {
    themePromise = getMarpThemes()
      .then((t) => { themeCache = Array.isArray(t) ? t : []; return themeCache; })
      .catch(() => { themeCache = []; return themeCache; });
  }
  return themePromise;
}
