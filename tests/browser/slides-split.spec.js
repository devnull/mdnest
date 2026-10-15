// A Marp deck in split view: text on the left, slides on the right.
//
// - A deck opens in split view on a desktop, unless a view was picked for
//   that file before; that pick stays with the file and does not change the
//   view other notes open in.
// - The slide shown follows the caret. It used to follow only the editor's
//   scroll ratio, and every keystroke re-applied it, so with the caret in
//   slide 6 and the editor scrolled lower the deck showed slide 7 or 8 while
//   the typing changed slide 6, out of sight.
import { test, expect, request as pwRequest } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';
const SEED = process.env.MDNEST_SEED_FILE || 'e2e-seed.md';

const filler = (n) => Array.from({ length: n }, (_, i) => `- point ${i + 1}`).join('\n');
const DECK = [
  '---', 'marp: true', 'paginate: true', '---', '',
  ...[1, 2, 3, 4, 5].flatMap((n) => [`# Slide ${n}`, '', 'Short.', '', '---', '']),
  '# Small to run', '', 'Slide six.', '', '---', '',
  '# Slide 7', '', filler(60), '', '---', '',
  '# Slide 8', '', filler(60), '',
].join('\n');

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

async function withDeck(baseURL, fn) {
  const api = await pwRequest.newContext({ baseURL });
  const auth = await api.post('/api/auth/login', { data: { username: USER, password: PASS } });
  const headers = { Authorization: `Bearer ${(await auth.json()).token}` };
  const path = `split-deck-${Date.now()}.md`;
  const url = `/api/note?ns=${NS}&path=${encodeURIComponent(path)}`;
  expect((await api.post(url, { headers, data: DECK })).status()).toBeLessThan(300);
  try {
    await fn(path);
  } finally {
    await api.delete(url, { headers });
    await api.dispose();
  }
}

// Opened from the tree, not by setting the URL hash: a hash set straight
// after sign-in sometimes lands before the app has loaded the namespace.
async function open(page, file) {
  await page.locator('.tree-row', { hasText: file }).first().click();
  await expect(page.locator('.toolbar-path')).toContainText(file.replace(/\.md$/, ''), { timeout: 20_000 });
}

const counter = (page) => page.locator('.preview-wrapper .marp-deck-counter');
const active = (page, title) => expect(page.locator(`button[title="${title}"]`)).toHaveClass(/\bactive\b/);

test('the deck in split view follows the caret, and the buttons until it moves', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await withDeck(baseURL, async (path) => {
    await signIn(page);
    await open(page, path);
    const ta = page.locator('.editor-textarea');
    await expect(ta).toBeVisible({ timeout: 20_000 });
    // Split view is the default for a deck (the next test); pick it here so
    // this test is about the caret alone.
    await page.locator('button[title="Split view"]').click();
    await expect(counter(page)).toHaveText('1 / 8', { timeout: 20_000 });

    // Scrolling alone still moves the deck.
    await ta.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(counter(page)).toHaveText('8 / 8');

    // The caret in slide 6, the editor still scrolled to the end: typing
    // shows slide 6, with the change.
    await ta.evaluate((el) => {
      const i = el.value.indexOf('Slide six.') + 'Slide six.'.length;
      el.focus({ preventScroll: true });
      el.setSelectionRange(i, i);
      el.scrollTop = el.scrollHeight;
    });
    await page.keyboard.type(' Typed here');
    await expect(counter(page)).toHaveText('6 / 8');
    const section = page.frameLocator('.preview-wrapper .marp-deck-frame').locator('section');
    await expect(section).toContainText('Slide six. Typed here');

    // A slide picked with the deck's buttons stays...
    await page.locator('.preview-wrapper button[aria-label="Next slide"]').click();
    await expect(counter(page)).toHaveText('7 / 8');
    await page.waitForTimeout(600);
    await expect(counter(page)).toHaveText('7 / 8');
    // ...until the caret moves again.
    await ta.focus();
    await page.keyboard.type('!');
    await expect(counter(page)).toHaveText('6 / 8');
  });
});

test('a deck opens in split view; a view picked for it stays with that file', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await withDeck(baseURL, async (path) => {
    await signIn(page);
    await open(page, SEED);
    await active(page, 'Editor only');

    await open(page, path);
    await expect(counter(page)).toHaveText('1 / 8', { timeout: 20_000 });
    await active(page, 'Split view');
    await expect(page.locator('.editor-textarea')).toBeVisible();

    // Pick "Preview only" for this deck: it sticks to the deck across a
    // reload, and the plain note keeps its own view.
    await page.locator('button[title="Preview only"]').click();
    await active(page, 'Preview only');
    await page.reload();
    await expect(counter(page)).toHaveText('1 / 8', { timeout: 20_000 });
    await active(page, 'Preview only');
    await expect(page.locator('.editor-textarea')).toHaveCount(0);

    await open(page, SEED);
    await active(page, 'Editor only');
    expect(await page.evaluate(() => localStorage.getItem('mdnest_view_mode'))).toBeNull();
  });
});
