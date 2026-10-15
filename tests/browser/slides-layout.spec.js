// How the "+ Slides" entry points look, not what they write (slides-new.spec.js
// covers the stored deck).
//
// - The sidebar's create buttons: with drawings and slides both on there are
//   four, and at the default 260px sidebar they used to squeeze into one row
//   with the labels touching the button edges.
// - The dialog's preview: the slide filled less than half the box, and the
//   box stayed a dark block in light mode.
// - On a phone the Create button sat below the fold, after the whole form.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.ns-label, .ns-select')).toBeVisible({ timeout: 20_000 });
  // "+ Slides" and "+ Drawing" appear once the server config has loaded,
  // after "+ Note". Counting them any earlier reads as "feature disabled"
  // and silently skips the test, so give them a moment first.
  await page.locator('button:has-text("+ Slides")').waitFor({ timeout: 5_000 }).catch(() => {});
}

// Shows only the first `count` create buttons and sizes the sidebar, then
// reports every problem with the row. The count attribute is what Sidebar.jsx
// writes from the same props that decide which buttons exist.
async function rowProblems(page, count, width) {
  return page.evaluate(([n, w]) => {
    const sidebar = document.querySelector('.sidebar');
    sidebar.style.width = `${w}px`;
    sidebar.style.minWidth = `${w}px`;
    const all = [...document.querySelectorAll('.sidebar-actions .sidebar-action-btn')];
    const row = all[0].parentElement;
    all.forEach((b, i) => { b.style.display = i < n ? '' : 'none'; });
    row.dataset.count = String(n);
    const btns = all.slice(0, n);
    const rowBox = row.getBoundingClientRect();
    const out = [];
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(b);
      const text = range.getBoundingClientRect().width;
      const label = b.textContent.trim();
      if (b.scrollWidth > b.clientWidth + 1) out.push(`${label}: label cut off`);
      // Room for the label: at least 6px either side of it.
      if ((r.width - text) / 2 < 6) out.push(`${label}: cramped (${Math.round(r.width)}px for ${Math.round(text)}px of text)`);
      if (r.right > rowBox.right + 0.5 || r.left < rowBox.left - 0.5) out.push(`${label}: outside the row`);
    }
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i].getBoundingClientRect();
        const b = btns[j].getBoundingClientRect();
        if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) {
          out.push(`${btns[i].textContent.trim()} overlaps ${btns[j].textContent.trim()}`);
        }
      }
    }
    return out;
  }, [count, width]);
}

test('the sidebar create buttons fit, at the default width and narrower', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const n = await page.locator('.sidebar-actions .sidebar-action-btn').count();
  test.skip(n < 4, 'needs ENABLE_EXCALIDRAW and ENABLE_MARP (four buttons)');
  for (const width of [260, 200, 180]) {
    for (const count of [2, 3, 4]) {
      expect(await rowProblems(page, count, width), `${count} buttons at ${width}px`).toEqual([]);
    }
  }
});

async function openDialog(page) {
  const btn = page.locator('button:has-text("+ Slides")');
  if (!(await btn.count())) test.skip(true, 'slides disabled (ENABLE_MARP)');
  await btn.click();
  await expect(page.getByTestId('new-deck-preview').locator('.marp-deck-counter')).toBeVisible({ timeout: 20_000 });
}

// The slide frame against the preview box it sits in.
async function previewFit(page) {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid=new-deck-preview]').getBoundingClientRect();
    const frame = document.querySelector('[data-testid=new-deck-preview] .marp-deck-frame').getBoundingClientRect();
    return { box: box.width, frame: frame.width, ratio: frame.width / frame.height };
  });
}

test('the dialog preview fills its box, for 16:9 and 4:3', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openDialog(page);
  await page.getByTestId('new-deck-theme').selectOption('default');
  for (const [size, ratio] of [['16:9', 16 / 9], ['4:3', 4 / 3]]) {
    await page.getByTestId('new-deck-size').selectOption(size);
    await expect.poll(async () => (await previewFit(page)).ratio, { message: `${size} frame shape` })
      .toBeCloseTo(ratio, 1);
    const fit = await previewFit(page);
    // The box padding and borders are all that is left over.
    expect(fit.frame, `${size}: ${JSON.stringify(fit)}`).toBeGreaterThan(fit.box - 40);
  }
});

test('the dialog preview follows the light theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await openDialog(page);
  const lightness = await page.evaluate(() => {
    const luma = (el) => {
      const [r, g, b] = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const p = document.querySelector('[data-testid=new-deck-preview]');
    return {
      deck: luma(p.querySelector('.marp-deck')),
      controls: luma(p.querySelector('.marp-deck-controls')),
      button: luma(p.querySelector('.marp-deck-controls button')),
    };
  });
  for (const [part, l] of Object.entries(lightness)) expect(l, `${part} is dark in light mode`).toBeGreaterThan(0.7);
});

test('on a phone, Cancel and Create stay on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const toggle = page.locator('button[title="Toggle sidebar"]');
  if (await toggle.count()) await toggle.first().click();
  await openDialog(page);
  for (const id of ['new-deck-create']) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b.y + b.height, 'Create is below the fold').toBeLessThanOrEqual(844);
    expect(b.x + b.width, 'Create is off the right edge').toBeLessThanOrEqual(390);
  }
  const cancel = await page.locator('[data-testid=new-deck-modal] .modal-actions .modal-btn').boundingBox();
  expect(cancel.y + cancel.height).toBeLessThanOrEqual(844);
  // The rest of the form is still reachable, by scrolling the dialog body.
  const footer = page.getByTestId('new-deck-footer');
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeInViewport();
  await expect(page.getByTestId('new-deck-create')).toBeInViewport();
});
