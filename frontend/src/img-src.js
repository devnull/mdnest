// resolveImgSrc — turn a markdown image href into the <img src> the Preview
// renders. A relative path resolves against the note's directory under
// /api/files/ and carries the session JWT as ?token=, because a browser
// <img> GET cannot set an Authorization header (the auth middleware accepts
// the query-param fallback for exactly this case — same mechanism the Live
// editor's proxyDomURL uses). Absolute http(s)/data:/rooted hrefs pass
// through untouched: the token must never ride along to a foreign host
// (same scoping rule as the Marp export asset inliner).
//
// Pure module (no React, no api.js import) so it is unit-testable standalone;
// Preview.jsx supplies the token from api.js getToken().
//
// Explicit schemes and rooted URLs pass through without credentials, including
// protocol-relative URLs and the backslash form browsers normalize to slashes.
// A filename such as http-flow.png is still relative: require a scheme's colon
// rather than treating every filename beginning with "http" as a remote URL.
const ABSOLUTE_SRC = /^(?:[a-z][a-z\d+.-]*:|[\\/])/i;
// Used only to parse relative paths; no request is made to this reserved host.
const URL_BASE = 'https://mdnest.invalid';

export function resolveImgSrc(href, baseDir, token) {
  const src = typeof href === 'string' ? href.trim() : '';
  if (!src || ABSOLUTE_SRC.test(src)) return src;
  try {
    const url = new URL(baseDir + src, URL_BASE);
    // Normalize before adding credentials: ../ must not move the token onto
    // another endpoint, and an external base must never receive it.
    if (url.origin !== URL_BASE || !url.pathname.startsWith('/api/files/')) return '';
    if (token) url.searchParams.set('token', token);
    return url.pathname + url.search + url.hash;
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Escape before HTML assembly. Quotes in a local image destination must not
// turn its appended session token into an attacker-controlled srcset URL.
export function renderImageHtml({ href, title, text }, baseDir, token) {
  const src = resolveImgSrc(href, baseDir, token);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr} />`;
}
