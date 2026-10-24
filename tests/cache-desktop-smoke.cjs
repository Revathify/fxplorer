'use strict';

// End-to-end checks for saved hierarchical scans and refractive-glass settings.
// All filesystem writes are confined to this run's ignored .test-output directory.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');
const timeout = 30_000;
const errors = [];

async function makeFile(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 0x61));
}

async function makeCacheFixture(dir) {
  const levels = [dir];
  for (let depth = 1; depth <= 5; depth++) {
    const child = path.join(levels.at(-1), `Level ${depth}`);
    await fs.mkdir(child, { recursive: true });
    levels.push(child);
    await makeFile(path.join(child, `level-${depth}.txt`), depth * 1024);
  }
  await makeFile(path.join(dir, 'root.txt'), 512);
  return levels;
}

async function makeLiveFixture(dir) {
  const first = path.join(dir, 'A completed branch');
  const next = path.join(dir, 'B long branch');
  await fs.mkdir(first, { recursive: true });
  await fs.mkdir(next, { recursive: true });
  for (let i = 0; i < 240; i++) await makeFile(path.join(first, `tile-${i}.dat`), 16 * 1024);
  for (let i = 0; i < 9000; i++) await makeFile(path.join(next, `item-${String(i).padStart(5, '0')}.dat`), 512);
}

async function waitFolder(page, folder) {
  await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), folder, { timeout });
}

async function navigate(page, folder) {
  const address = page.locator('#address');
  await address.fill(folder);
  await address.press('Enter');
  await waitFolder(page, folder);
}

async function totals(page, folder, expected) {
  await waitFolder(page, folder);
  assert.equal(await page.locator('#snapshot-badge').isVisible(), true, `saved snapshot should be visible at ${folder}`);
  const rendered = await page.locator('#detail-content .detail-meta').evaluate(list => {
    const result = {};
    for (const label of list.querySelectorAll('dt')) result[label.textContent.trim()] = label.nextElementSibling?.textContent.trim();
    return result;
  });
  assert.equal(rendered.Files, String(expected.files), `wrong rendered file total at ${folder}: ${JSON.stringify(rendered)}`);
  assert.equal(rendered.Subfolders, String(expected.folders), `wrong rendered subfolder total at ${folder}: ${JSON.stringify(rendered)}`);
  const cached = await page.evaluate(p => window.fxplorer.cachedScan(p), folder);
  assert.deepEqual([cached.fileCount, cached.folderCount], [expected.files, expected.folders], `preload cache lookup totals at ${folder}`);
  assert.ok(await page.locator('.map-block').count() > 0, `saved map should render at ${folder}`);
}

async function diagnosticsScanStarts(profile) {
  const hits = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === 'diagnostics.log') {
        const data = await fs.readFile(target, 'utf8');
        hits.push(...data.matchAll(/"event":"scan-start"/g));
      }
    }
  }
  await visit(profile);
  return hits.length;
}

async function applyTheme(page, id, glass, solid) {
  if (!(await page.locator('#settings-dialog').evaluate(dialog => dialog.open))) await page.locator('#settings-button').click();
  await page.locator(`#settings-dialog [data-theme-choice="${id}"]`).click();
  await page.locator('#setting-glass').selectOption(String(glass));
  await page.locator('#setting-solid').setChecked(solid);
  await page.waitForFunction(([theme, level, opaque]) => {
    const r = document.documentElement;
    return r.dataset.theme === theme && r.dataset.glassLevel === String(level) && r.dataset.solid === String(opaque);
  }, [id, glass, solid]);
  const visual = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const style = getComputedStyle(sidebar);
    const main = getComputedStyle(document.querySelector('.main'));
    const dialog = document.querySelector('#settings-dialog');
    const bounds = dialog.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      glass: document.documentElement.dataset.glassLevel,
      solid: document.documentElement.dataset.solid,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      themeBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      panelMix: getComputedStyle(document.documentElement).getPropertyValue('--panel-mix').trim(),
      mainBg: main.backgroundColor,
      sidebarBg: style.backgroundColor,
      dialogFits: bounds.width <= innerWidth && bounds.height <= innerHeight,
      dialogScrollable: dialog.scrollHeight >= dialog.clientHeight,
      settingsButtonReachable: document.querySelector('#settings-button').getBoundingClientRect().bottom <= innerHeight
    };
  });
  assert.ok(visual.dialogFits, `settings dialog exceeds the viewport: ${JSON.stringify(visual)}`);
  assert.ok(visual.settingsButtonReachable, 'settings launch control should remain reachable');
  if (id === 'light') {
    assert.equal(visual.themeBg, '#f5f7f9', 'light theme should resolve to the light background token');
    assert.notEqual(visual.sidebarBg, 'rgb(0, 0, 0)', 'light sidebar must not collapse to opaque black');
  } else if (solid) {
    assert.equal(visual.backdrop, 'none', 'solid panels should remove backdrop blur');
  } else {
    assert.match(visual.backdrop, /blur\(/, `glass surface should have computed blur at level ${glass}`);
  }
  return visual;
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'cache-desktop-'));
  const fixture = path.join(run, 'Cached hierarchy');
  const levels = await makeCacheFixture(fixture);
  const liveFixture = path.join(run, 'Live map');
  await makeLiveFixture(liveFixture);
  const profile = path.join(run, 'profile');
  let app;
  let page;
  try {
    app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.waitForFunction(() => document.getElementById('address').value.length > 0, undefined, { timeout });
    await navigate(page, fixture);
    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'), undefined, { timeout });
    assert.equal(await page.locator('#snapshot-badge').isVisible(), true, 'completed scan should show snapshot badge');
    const startCount = await diagnosticsScanStarts(profile);
    assert.equal(startCount, 1, 'one scan should be logged for the cached fixture');

    const expectedByDepth = [
      { folders: 5, files: 6 }, { folders: 4, files: 5 }, { folders: 3, files: 4 },
      { folders: 2, files: 3 }, { folders: 1, files: 2 }
    ];
    for (let depth = 0; depth <= 4; depth++) {
      if (depth > 0) await navigate(page, levels[depth]);
      await totals(page, levels[depth], expectedByDepth[depth]);
    }
    for (let depth = 4; depth > 0; depth--) {
      await page.locator('#back').click();
      await waitFolder(page, levels[depth - 1]);
      await totals(page, levels[depth - 1], expectedByDepth[depth - 1]);
    }
    assert.equal(await diagnosticsScanStarts(profile), startCount, 'opening retained levels and using Back must not start another scan');
    const parentTile = page.locator('.map-block').filter({ hasText: 'Level 1' }).first();
    const tileBox = await parentTile.boundingBox();
    assert.ok(tileBox, 'root map should render the direct child folder tile');
    await parentTile.dblclick({ position: { x: Math.round(tileBox.width / 2), y: Math.round(tileBox.height / 2) } });
    await waitFolder(page, levels[1]);
    assert.equal(await page.locator('#snapshot-badge').isVisible(), true, 'double-clicking a map folder should open its retained snapshot');
    assert.equal(await page.locator('#address').inputValue(), levels[1], 'map folder activation should open exactly that folder');
    await page.locator('#back').click();
    await waitFolder(page, fixture);
    await navigate(page, levels[5]);
    assert.equal(await page.locator('#snapshot-badge').isVisible(), false, 'level five is deeper than retainDepth=4 and must not claim a saved snapshot');
    assert.equal(await diagnosticsScanStarts(profile), startCount, 'uncached deeper lookup should not silently rescan');

    const screenshots = [];
    let noxLevelOneMix;
    for (const [theme, glass, solid] of [
      ['nox-amethyst', 1, false], ['neon-maritime', 5, true], ['obsidian-guava', 3, false], ['obsidian-neon', 4, true], ['light', 5, false]
    ]) {
      const visual = await applyTheme(page, theme, glass, solid);
      if (theme === 'nox-amethyst') noxLevelOneMix = visual.panelMix;
      const file = path.join(output, `fxplorer-glass-${theme}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      screenshots.push(path.relative(root, file));
      assert.equal(visual.glass, String(glass));
    }
    const noxLevelFive = await applyTheme(page, 'nox-amethyst', 5, false);
    assert.notEqual(noxLevelFive.panelMix, noxLevelOneMix, `glass levels 1 and 5 should change the palette surface mix (${noxLevelOneMix} vs ${noxLevelFive.panelMix})`);
    await page.locator('#close-settings').click();
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(overflow.scroll <= overflow.width, `1100x720 window has horizontal document overflow: ${JSON.stringify(overflow)}`);

    await app.close();
    app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.waitForFunction(() => document.getElementById('address').value.length > 0, undefined, { timeout });
    await navigate(page, fixture);
    await totals(page, fixture, expectedByDepth[0]);
    await applyTheme(page, 'nox-amethyst', 3, false);
    await page.locator('#close-settings').click();
    await page.locator('.sidebar').evaluate(sidebar => { sidebar.scrollTop = 0; });
    const showcase = path.join(output, 'fxplorer-cache-glass-showcase.png');
    await page.screenshot({ path: showcase, animations: 'disabled' });
    screenshots.push(path.relative(root, showcase));
    await navigate(page, levels[4]);
    await totals(page, levels[4], expectedByDepth[4]);
    assert.equal(await diagnosticsScanStarts(profile), startCount, 'relaunch and cached root/deep restore must not scan again');

    const cacheInfo = await page.evaluate(() => window.fxplorer.cacheInfo());
    assert.equal(cacheInfo.bundles, 1, 'isolated profile should contain exactly the generated fixture bundle');
    assert.ok(cacheInfo.snapshots >= 5, `expected root plus retained hierarchy snapshots, got ${cacheInfo.snapshots}`);
    await navigate(page, fixture);
    await page.locator('#settings-button').click();
    await page.waitForFunction(() => document.querySelector('#cache-summary')?.textContent.includes('saved analyses'));
    const summary = await page.locator('#cache-summary').textContent();
    assert.match(summary, /1 saved analyses/);
    await page.locator('#clear-cache').click();
    await page.waitForFunction(() => document.querySelector('#cache-summary')?.textContent.startsWith('0 saved analyses'));
    await page.locator('#close-settings').click();
    assert.equal(await page.locator('#snapshot-badge').isVisible(), false, 'clearing saved scans should hide the active snapshot badge');
    assert.equal((await page.evaluate(() => window.fxplorer.cacheInfo())).bundles, 0, 'cache API should report empty after clear');
    assert.ok((await fs.stat(path.join(fixture, 'root.txt'))).isFile(), 'clearing cache must preserve generated source files');
    assert.ok((await fs.stat(path.join(levels[5], 'level-5.txt'))).isFile(), 'clearing cache must preserve deeper generated files');

    // The live fixture exercises progress events and map DOM before final completion.
    await navigate(page, liveFixture);
    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#scan-label').textContent === 'Stop analysis', undefined, { timeout });
    await page.waitForFunction(() => {
      const label = document.querySelector('#scan-label')?.textContent;
      return label === 'Stop analysis' && document.querySelectorAll('.map-block').length > 0;
    }, undefined, { timeout: 20_000, polling: 100 });
    const live = await page.evaluate(() => ({
      label: document.querySelector('#scan-label').textContent,
      blocks: document.querySelectorAll('.map-block').length,
      subtiles: document.querySelectorAll('.map-subtile').length,
      colors: new Set([...document.querySelectorAll('.map-block')].map(node => node.style.background)).size
    }));
    assert.equal(live.label, 'Stop analysis', 'live map evidence must be captured before scanner completion');
    assert.ok(live.blocks > 0 && live.subtiles === 0 && live.colors > 1, `live map should show only distinct direct-child blocks: ${JSON.stringify(live)}`);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'), undefined, { timeout });
    assert.deepEqual(errors, [], 'renderer should not emit page errors');
    console.log('Saved scan desktop smoke passed: four retained depths, browser history, restart restore, isolated cache info/clear, five palettes/themes, glass levels 1/5, solid panels, viewport fit, and live colored map before completion.');
    console.log(`Revision: ${require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`);
    console.log(`Evidence: ${screenshots.join(', ')}`);
    console.log(`Fixture/profile: ${path.relative(root, run)}`);
  } finally {
    if (app) await app.close().catch(() => {});
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
