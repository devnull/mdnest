// "Copy browser link" in the tree's right-click menu: the copied link, opened
// in a fresh page, opens the same note. The note's name has a space, a "#"
// and a "?" so a link built without percent-encoding would open something
// else (a "#" would start the heading part, a "?" a query string).
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = 'testing_workspace';

async function login(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + t }, body });
    return { status: r.status };
  }, { method, path, body });
}

const note = (p) => `/note?ns=${NS}&path=${encodeURIComponent(p)}`;

test('Copy browser link opens the same note in a new page', async ({ page, context }) => {
  const folder = `link-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const name = 'C# notes? v2.md';
  await login(page);
  try {
    expect((await api(page, 'POST', note(`${folder}/${name}`), '# Link target\n\nlink body')).status).toBe(201);
    await page.reload();
    const folderRow = page.locator('.tree-row', { hasText: folder }).first();
    await expect(folderRow).toBeVisible({ timeout: 20_000 });
    await folderRow.click();
    const row = page.locator('.tree-row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Folders do not offer it: a folder has no page of its own.
    await folderRow.click({ button: 'right' });
    await expect(page.locator('.context-menu-item', { hasText: 'Copy path for CLI' })).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: 'Copy browser link' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await row.click({ button: 'right' });
    await page.locator('.context-menu-item', { hasText: 'Copy browser link' }).click();
    await expect(page.getByTestId('notice-bar')).toContainText('Copied the browser link');
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link.startsWith(new URL(page.url()).origin + '/#')).toBe(true);

    const other = await context.newPage();
    await other.goto(link);
    await expect(other.locator('.toolbar-path')).toContainText(name, { timeout: 20_000 });
    await expect(other.locator('.preview-pane, .editor-textarea, .live-editor-wrapper').first()).toContainText('link body', { timeout: 20_000 });
    await other.close();
  } finally {
    await api(page, 'DELETE', note(folder)).catch(() => {});
  }
});
