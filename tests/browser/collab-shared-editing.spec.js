// Two people typing into one note at the same time must both keep their text.
//
// Before shared editing, every browser saved the WHOLE file 800 ms after the
// last keystroke, and the server only checked the ETag. Two people typing at
// once produced "This file was modified by another user", and one of them lost
// what they had typed after a refresh. This drives two accounts in two browser
// contexts, both typing into the same note in the Live editor at the same
// time, then checks the file on disk holds both people's words and that no
// conflict banner ever appeared.
//
// It needs live collab and two accounts, so it runs from
// tests/e2e-collab-multi.sh (multi mode). In the single-mode stack it skips.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const USER2 = process.env.MDNEST_USER2 || '';
const PASS2 = process.env.MDNEST_PASSWORD2 || '';
const NOTES_DIR = process.env.MDNEST_NOTES_DIR || '';
const NS = 'testing_workspace';

async function login(page, u, p) {
  await page.goto('/');
  await page.fill('input[name=username]', u);
  await page.fill('input[name=password]', p);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
}

const collabEnabled = (page) =>
  page.evaluate(async () => (await (await fetch('/api/config')).json()).liveCollab === true);

// Writes through the API as the signed-in user of `page`.
async function putNote(page, file, body) {
  await page.evaluate(async ({ ns, file, body }) => {
    const t = localStorage.getItem('mdnest_token');
    const url = `/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(file)}`;
    await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: '' });
    const r = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + t }, body });
    if (!r.ok) throw new Error('PUT ' + r.status);
  }, { ns: NS, file, body });
}

async function readNote(page, file) {
  if (NOTES_DIR) return fs.readFileSync(path.join(NOTES_DIR, NS, file), 'utf8');
  return page.evaluate(async ({ ns, file }) => {
    const t = localStorage.getItem('mdnest_token');
    const url = `/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(file)}`;
    return (await fetch(url, { headers: { Authorization: 'Bearer ' + t } })).text();
  }, { ns: NS, file });
}

// Records whether the conflict banner was EVER shown, not just at the end:
// the old code cleared it on the next keystroke, so an end-of-test check alone
// would miss it.
async function watchForConflictBanner(page) {
  await page.evaluate(() => {
    window.__mdnestSawConflict = false;
    const seen = () => {
      for (const el of document.querySelectorAll('.conflict-banner')) {
        if (/modified by/i.test(el.textContent || '')) window.__mdnestSawConflict = true;
      }
    };
    new MutationObserver(seen).observe(document.body, { childList: true, subtree: true, characterData: true });
    seen();
  });
}

async function openInLive(page, file) {
  await page.goto(`/#${NS}/${file}`);
  await expect(page.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  const liveBtn = page.locator('.toolbar button[title="Live rich editor"]');
  if (await liveBtn.count()) await liveBtn.click();
  await expect(page.locator('.editor-wrapper .ProseMirror')).toBeVisible({ timeout: 20_000 });
}

// Puts the caret at the end of the paragraph holding `text`.
async function caretAfter(page, text) {
  const para = page.locator('.editor-wrapper .ProseMirror p', { hasText: text }).first();
  await para.click();
  await page.keyboard.press('End');
}

async function setup(browser) {
  if (!USER2) test.skip(true, 'set MDNEST_USER2/MDNEST_PASSWORD2 to run (tests/e2e-collab-multi.sh)');
  const a = await browser.newContext(); const pageA = await a.newPage();
  await login(pageA, USER, PASS);
  if (!(await collabEnabled(pageA))) { await a.close(); test.skip(true, 'live collab disabled'); }
  const b = await browser.newContext(); const pageB = await b.newPage();
  await login(pageB, USER2, PASS2);
  return { a, b, pageA, pageB };
}

test('two people typing into one note at once both keep their text', async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, b, pageA, pageB } = await setup(browser);

  const file = `collab-both-${Date.now()}.md`;
  await putNote(pageA, file, '# Shared\n\nfirst line\n\nsecond line\n');

  await openInLive(pageA, file);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await watchForConflictBanner(pageA);
  await watchForConflictBanner(pageB);

  await caretAfter(pageA, 'first line');
  await caretAfter(pageB, 'second line');

  // Interleaved bursts with pauses longer than the autosave delay, so both
  // tabs save several times while the other is still typing.
  const wordsA = ['alpha1', 'alpha2', 'alpha3', 'alpha4', 'alpha5'];
  const wordsB = ['bravo1', 'bravo2', 'bravo3', 'bravo4', 'bravo5'];
  const typeAll = async (page, words) => {
    for (const w of words) {
      await page.keyboard.type(' ' + w, { delay: 40 });
      await page.waitForTimeout(900);
    }
  };
  await Promise.all([typeAll(pageA, wordsA), typeAll(pageB, wordsB)]);

  // Let the last saves land.
  const all = [...wordsA, ...wordsB];
  await expect.poll(async () => {
    const disk = await readNote(pageA, file);
    return all.filter((w) => !disk.includes(w));
  }, { timeout: 20_000, message: 'words missing from the file on disk' }).toEqual([]);

  // Both editors show everyone's words.
  for (const page of [pageA, pageB]) {
    const text = await page.locator('.editor-wrapper .ProseMirror').innerText();
    expect(all.filter((w) => !text.includes(w)), 'words missing from an editor').toEqual([]);
  }

  expect(await pageA.evaluate(() => window.__mdnestSawConflict), 'conflict banner shown to A').toBe(false);
  expect(await pageB.evaluate(() => window.__mdnestSawConflict), 'conflict banner shown to B').toBe(false);

  // A refresh shows the same text: nothing was only in memory.
  await pageB.reload();
  await expect(pageB.locator('.editor-wrapper .ProseMirror')).toBeVisible({ timeout: 20_000 });
  const afterReload = await pageB.locator('.editor-wrapper .ProseMirror').innerText();
  expect(all.filter((w) => !afterReload.includes(w)), 'words lost after a refresh').toEqual([]);

  await b.close(); await a.close();
});

test('opening a shared note and leaving without typing does not change the file', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);

  // Markdown that the Live editor would write back differently if it ever
  // saved without an edit: `*` bullets (it writes `-`), `__bold__`, a setext
  // heading, front matter, a table, and no trailing newline.
  const file = `collab-untouched-${Date.now()}.md`;
  const body = '---\ntitle: Untouched\ntags: [a, b]\n---\n\nHeading\n=======\n\n* one\n* two\n\n__bold__ and *em*\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nlast line';
  await putNote(pageA, file, body);
  const before = await readNote(pageA, file);

  await openInLive(pageA, file);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await pageA.waitForTimeout(4000);
  await pageA.goto('/#');
  await pageB.goto('/#');
  await pageA.waitForTimeout(2000);

  expect(await readNote(pageA, file), 'the file changed although nobody typed').toBe(before);
  await b.close(); await a.close();
});

test('the saver closing the tab right after typing does not lose the text', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);
  const file = `collab-leave-${Date.now()}.md`;
  await putNote(pageA, file, '# Leave\n\nkeep this line\n');

  // A opens first, so A seeds the room and is its saver.
  await openInLive(pageA, file);
  await pageA.waitForTimeout(1500);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });

  await caretAfter(pageA, 'keep this line');
  await pageA.keyboard.type(' zululeft', { delay: 20 });
  // Well inside the 800 ms save delay.
  await a.close();

  await expect.poll(async () => (await readNote(pageB, file)).includes('zululeft'),
    { timeout: 20_000, message: 'text typed just before the saver left never reached the file' }).toBe(true);
  await expect(pageB.locator('.editor-wrapper .ProseMirror')).toContainText('zululeft');
  await b.close();
});

test('an outside change merges into a note people are editing', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);
  const file = `collab-outside-${Date.now()}.md`;
  await putNote(pageA, file, '# Outside\n\nfirst\n\nsecond\n');
  await openInLive(pageA, file);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await watchForConflictBanner(pageA);
  await watchForConflictBanner(pageB);

  await caretAfter(pageA, 'first');
  await pageA.keyboard.type(' typedinroom', { delay: 20 });

  // What the CLI does: a plain PUT that knows nothing about the room.
  await pageB.evaluate(async ({ ns, file }) => {
    const t = localStorage.getItem('mdnest_token');
    const url = `/api/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(file)}`;
    const cur = await (await fetch(url, { headers: { Authorization: 'Bearer ' + t } })).text();
    await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + t }, body: cur.replace(/\n*$/, '\n\nadded by the cli\n') });
  }, { ns: NS, file });

  await expect.poll(async () => {
    const disk = await readNote(pageA, file);
    return disk.includes('typedinroom') && disk.includes('added by the cli');
  }, { timeout: 25_000, message: 'the file lost either the room text or the outside change' }).toBe(true);
  for (const page of [pageA, pageB]) {
    await expect(page.locator('.editor-wrapper .ProseMirror')).toContainText('added by the cli', { timeout: 15_000 });
    await expect(page.locator('.editor-wrapper .ProseMirror')).toContainText('typedinroom');
  }
  expect(await pageA.evaluate(() => window.__mdnestSawConflict)).toBe(false);
  expect(await pageB.evaluate(() => window.__mdnestSawConflict)).toBe(false);
  await b.close(); await a.close();
});

test('typing in a shared note keeps the front matter byte for byte', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);
  const file = `collab-fm-${Date.now()}.md`;
  const fm = '---\ntitle: Front matter stays\ntags: [x, y]\nweird:   spacing\n---\n\n';
  await putNote(pageA, file, fm + 'body line\n');
  await openInLive(pageA, file);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });
  await caretAfter(pageB, 'body line');
  await pageB.keyboard.type(' edited', { delay: 20 });
  await expect.poll(async () => (await readNote(pageA, file)).includes('edited'), { timeout: 20_000 }).toBe(true);
  const disk = await readNote(pageA, file);
  expect(disk.startsWith(fm), `front matter changed:\n${disk}`).toBe(true);
  await b.close(); await a.close();
});

test('moving the folder of a shared note closes the room and never re-creates the old file', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);
  const dir = `collab-move-${Date.now()}`;
  const file = `${dir}/note.md`;
  await pageA.evaluate(async ({ ns, dir }) => {
    const t = localStorage.getItem('mdnest_token');
    await fetch(`/api/folder?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(dir)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
  }, { ns: NS, dir });
  await putNote(pageA, file, '# Move\n\nbefore the move\n');
  await openInLive(pageA, file);
  await openInLive(pageB, file);
  await expect(pageA.locator('.presence-bar')).toBeVisible({ timeout: 30_000 });

  await pageA.evaluate(async ({ ns, dir }) => {
    const t = localStorage.getItem('mdnest_token');
    const r = await fetch(`/api/move?ns=${encodeURIComponent(ns)}&from=${encodeURIComponent(dir)}&to=${encodeURIComponent(dir + '-moved')}`, { method: 'POST', headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error('move ' + r.status);
  }, { ns: NS, dir });

  for (const page of [pageA, pageB]) {
    await expect(page.locator('[data-testid=missing-note-banner]')).toBeVisible({ timeout: 15_000 });
  }
  // Typing now must not write the old path back.
  await pageB.locator('.editor-wrapper .ProseMirror').click().catch(() => {});
  await pageB.keyboard.type(' after', { delay: 20 }).catch(() => {});
  await pageB.waitForTimeout(3000);
  if (NOTES_DIR) expect(fs.existsSync(path.join(NOTES_DIR, NS, file)), 'the old path was re-created').toBe(false);
  await b.close(); await a.close();
});

test('Basic mode switches to Live while someone else is in the note', async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, pageA, pageB } = await setup(browser);
  const file = `collab-basic-${Date.now()}.md`;
  await putNote(pageA, file, '# Basic\n\ntext\n');
  await pageA.goto(`/#${NS}/${file}`);
  await expect(pageA.locator('.toolbar-path')).toContainText(file, { timeout: 20_000 });
  await pageA.locator('.toolbar button', { hasText: /^Basic$/ }).click();
  await expect(pageA.locator('.editor-wrapper textarea')).toBeVisible({ timeout: 20_000 });

  await openInLive(pageB, file);
  await expect(pageA.locator('.editor-wrapper .ProseMirror')).toBeVisible({ timeout: 30_000 });
  await expect(pageA.locator('.toolbar button', { hasText: /^Basic$/ })).toBeDisabled();

  await b.close();
  // Alone again: Basic comes back (the presence list holds a leaver briefly).
  await expect(pageA.locator('.editor-wrapper textarea')).toBeVisible({ timeout: 60_000 });
  await a.close();
});
