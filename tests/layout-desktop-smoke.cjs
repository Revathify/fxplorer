const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'layout-desktop-'));
  const fixture = path.join(run, 'Workspace');
  await fs.mkdir(fixture);
  await fs.writeFile(path.join(fixture, 'sample.txt'), 'generated layout fixture');
  const profile = path.join(run, 'profile');
  const launch = () => electron.launch({ args: [root, `--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  const errors = [];
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    if (await page.locator('#ios-toggle-details').count()) await page.locator('#ios-toggle-details').click();
    assert.equal(await page.locator('.layout-separator').count(), 2, 'both separators are installed');
    await page.locator('#address').fill(fixture);
    await page.locator('#address').press('Enter');
    await page.waitForFunction(p => document.querySelector('#address').value === p, fixture);

    const untouched = await columns(page);
    await page.setViewportSize({ width: 1100, height: 720 });
    const responsive = await columns(page);
    assert.equal(responsive[0], 188, 'untouched navigation width follows responsive default');
    assert.equal(responsive[2], 245, 'untouched inspector width follows responsive default');
    assert.ok(responsive[1] >= 560, 'untouched layout keeps middle column at minimum');
    await page.setViewportSize({ width: 1480, height: 960 });
    assert.deepEqual(await columns(page), untouched, 'untouched defaults return at wide viewport');

    const initial = await columns(page);
    const left = page.locator('[data-layout-side="left"]');
    const leftBox = await left.boundingBox();
    await page.mouse.move(leftBox.x + 4, 200);
    await page.mouse.down();
    await page.mouse.move(leftBox.x + 54, 200, { steps: 4 });
    await page.mouse.up();
    const afterLeft = await columns(page);
    assert.ok(afterLeft[0] > initial[0] + 30, 'dragging left separator widens navigation');

    const right = page.locator('[data-layout-side="right"]');
    const rightBox = await right.boundingBox();
    await page.mouse.move(rightBox.x + 4, 200);
    await page.mouse.down();
    await page.mouse.move(rightBox.x - 46, 200, { steps: 4 });
    await page.mouse.up();
    const afterRight = await columns(page);
    assert.ok(afterRight[2] > afterLeft[2] + 30, 'dragging right separator widens inspector');

    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'));
    const mapRect = await page.locator('#treemap').boundingBox();
    const middleRect = await page.locator('.content').boundingBox();
    assert.ok(mapRect.x >= middleRect.x && mapRect.x + mapRect.width <= middleRect.x + middleRect.width, 'treemap remains inside middle column');

    await left.focus();
    await page.keyboard.press('ArrowRight');
    const afterKeyboard = await columns(page);
    assert.ok(afterKeyboard[0] >= afterRight[0] + 9, 'keyboard separator resize changes navigation width');
    await page.keyboard.press('Home');
    assert.equal((await columns(page))[0], 160, 'Home reaches the navigation minimum');

    const handleBox = await left.boundingBox();
    await page.mouse.move(handleBox.x + 4, 200);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 34, 200);
    await page.dispatchEvent('[data-layout-side="left"]', 'pointercancel');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('layout-resizing')), false, 'pointercancel removes resize state');
    await page.keyboard.press('Control+l');
    await page.locator('#address').click({ position: { x: 20, y: 15 } });
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('layout-resizing')), false, 'later pointer activity is not trapped');

    await page.setViewportSize({ width: 1100, height: 720 });
    const viewport = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, cols: [...document.querySelector('.workspace').children].slice(0, 3).map(el => el.getBoundingClientRect().width) }));
    assert.ok(viewport.scroll <= viewport.width, `1100px viewport has no horizontal overflow (${viewport.scroll}px)`);
    assert.ok(viewport.cols[1] >= 560, 'middle column retains its minimum width at 1100×720');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')));
    assert.ok(saved.left >= 160 && saved.left <= 420 && saved.right >= 220 && saved.right <= 480, 'stored widths remain within configured bounds');

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout'))), saved, 'layout preferences survive application restart');
    const restored = await columns(page);
    assert.equal(restored[0], saved.left, 'saved navigation width is visible after restart');
    assert.equal(restored[2], saved.right, 'saved inspector width is visible after restart');

    await page.evaluate(() => localStorage.setItem('fxplorer-layout', JSON.stringify({ left: 420, right: 480 })));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.layout-separator[aria-valuenow]'));
    await page.setViewportSize({ width: 1100, height: 720 });
    const narrowInitial = await columns(page);
    await page.locator('[data-layout-side="left"]').focus();
    await page.keyboard.press('End');
    const leftMax = Number(await page.locator('[data-layout-side="left"]').getAttribute('aria-valuemax'));
    const afterLeftEnd = await columns(page);
    assert.equal(afterLeftEnd[0], leftMax, 'End reaches the announced navigation maximum after contraction');
    assert.ok(afterLeftEnd[2] >= 220 && afterLeftEnd[1] >= 560, 'navigation maximum preserves inspector and middle minimums');
    await page.locator('[data-layout-side="right"]').focus();
    await page.keyboard.press('End');
    const rightMax = Number(await page.locator('[data-layout-side="right"]').getAttribute('aria-valuemax'));
    const afterRightEnd = await columns(page);
    assert.equal(afterRightEnd[2], rightMax, 'End reaches the announced inspector maximum after contraction');
    assert.equal(afterRightEnd[0], 160, 'inspector maximum reduces navigation only to its minimum');
    assert.ok(afterRightEnd[1] >= 560, 'inspector maximum preserves the middle minimum');
    const narrowSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')));
    assert.ok(afterRightEnd[0] + afterRightEnd[2] <= narrowInitial[0] + narrowInitial[1] + narrowInitial[2] - 560, 'manual resize saves the visible panel pair within the reserved middle width');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('.layout-separator[aria-valuenow]'));
    assert.deepEqual(await columns(page).then(cols => [cols[0], cols[2]]), [narrowSaved.left, narrowSaved.right], 'contracted manual widths remain consistent after restart');

    await page.evaluate(() => localStorage.setItem('fxplorer-layout', JSON.stringify({ left: 999999, right: -10 })));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.layout-separator[aria-valuenow]'));
    assert.deepEqual(await columns(page).then(cols => [cols[0], cols[2]]), [420, 220], 'corrupt out-of-range stored widths are safely clamped');
    await page.locator('[data-layout-side="right"]').dblclick();
    assert.equal((await columns(page))[2], await page.evaluate(() => innerWidth <= 1280 ? 245 : 272), 'double-click restores responsive inspector default');
    assert.deepEqual(errors, [], 'renderer reports no uncaught errors');
    console.log('Layout desktop smoke passed: pointer, keyboard, cancel cleanup, middle-column map, 1100×720 fit, persistence and reset.');
  } finally { await app.close().catch(() => {}); }
}

async function columns(page) {
  return page.evaluate(() => [...document.querySelector('.workspace').children].slice(0, 3).map(el => Math.round(el.getBoundingClientRect().width)));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
