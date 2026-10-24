const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');
const errors = [];

async function main() {
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'ios-workspace-'));
  const fixture = path.join(run, 'Workspace');
  const profile = path.join(run, 'profile');
  await makeFixture(fixture);
  const launch = () => electron.launch({ args: [root, `--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.edition), 'ios-preview');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ios-light');
    assert.deepEqual(await page.evaluate(() => ({ layout: document.documentElement.dataset.fileLayout, details: document.documentElement.dataset.detailsVisible })), { layout: 'grid', details: 'false' }, 'new workspace starts in grid view with details collapsed');
    assert.equal(await page.locator('.tabbar').evaluate(n => getComputedStyle(n).display), 'none', 'single-tab strip is hidden');
    assert.equal(await page.locator('.ios-sidebar-card').count(), 1);
    assert.equal(await page.locator('.ios-main-card').count(), 1);
    assert.equal(await page.locator('.ios-inspector-card').count(), 1);

    await page.locator('#ios-list-view').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fileLayout), 'list');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fileLayout), 'list', 'non-default list preference survives restart');
    await page.keyboard.press('Control+l');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'address', 'Ctrl+L focuses path editor');
    await page.locator('#address').fill(fixture);
    await page.locator('#address').press('Enter');
    await page.waitForFunction(p => document.querySelector('#address').value === p && document.querySelectorAll('.file-row').length > 0, fixture);
    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'));
    assert.equal(await page.locator('.map-block').count(), 5, 'root map shows only five immediate fixture entries');

    await page.locator('#settings-button').click();
    await page.locator('#close-settings').click(); // Materialize settings controls before comparing the DOM across themes.
    const controlIds = ['address', 'scan', 'new-tab', 'settings-button', 'ios-list-view', 'ios-grid-view', 'ios-toggle-details'];
    const baseline = await structure(page, controlIds);
    const appearanceSettings = await page.evaluate(() => [window.fxSettings.accent, window.fxSettings.glassLevel, window.fxSettings.solidPanels]);
    await setTheme(page, 'pastel');
    await assertCoreControls(page, controlIds, 'Pastel');
    await setTheme(page, 'nox-amethyst');
    await assertCoreControls(page, controlIds, 'Refractive Glass');
    await setTheme(page, 'ios-light');
    await assertStructure(page, baseline, controlIds, 'iOS return');
    assert.deepEqual(await page.evaluate(() => [window.fxSettings.accent, window.fxSettings.glassLevel, window.fxSettings.solidPanels]), appearanceSettings, 'iOS return preserves accent, glass level and solid-panel preferences');

    await page.locator('#ios-grid-view').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fileLayout), 'grid');
    await page.locator('#ios-toggle-details').click();
    assert.equal(await page.locator('#ios-toggle-details').getAttribute('aria-expanded'), 'true', 'explicit details toggle opens inspector');
    assert.equal(await page.locator('.ios-inspector-card').count(), 1);
    await page.getByRole('separator', { name: 'Resize details panel', exact: true }).press('ArrowLeft');
    const widthOpen = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')).right);
    await page.locator('#ios-toggle-details').click();
    assert.equal(await page.locator('#ios-toggle-details').getAttribute('aria-expanded'), 'false', 'explicit toggle hides inspector');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.detailsVisible), 'false');
    await page.locator('#ios-toggle-details').click();
    assert.equal(await page.locator('#ios-toggle-details').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('.inspector').getBoundingClientRect().width)), widthOpen, 'saved details width returns after hide/show');

    await page.locator('#new-tab').click();
    await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 2);
    assert.notEqual(await page.locator('.tabbar').evaluate(n => getComputedStyle(n).display), 'none', 'tab strip appears after adding a second tab');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fileLayout), 'grid', 'switch to grid is active before restart');
    const savedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fileLayout), 'grid', 'grid/list preference survives restart');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ios-light', 'iOS selection survives theme roundtrip and restart');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.detailsVisible), 'true', 'explicit details visibility persists');
    assert.deepEqual(await page.evaluate(() => [Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), Math.round(document.querySelector('.inspector').getBoundingClientRect().width)]), [savedLayout.left ?? 212, savedLayout.right ?? 272], 'panel widths survive restart (unsaved width uses its default)');

    await page.keyboard.press('Control+l');
    await page.locator('#address').fill(fixture);
    await page.locator('#address').press('Enter');
    await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), fixture);
    assert.equal(await page.locator('.map-block').count(), 5, 'saved scan restores root immediate-child map');
    const rootSize = (await page.evaluate(p => window.fxplorer.cachedScan(p), fixture)).totalSize;
    await page.locator('#ios-toggle-details').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.detailsVisible), 'false', 'detail pane is hidden before folder drilldown');
    await page.locator('.map-block').filter({ hasText: 'Projects' }).dblclick();
    await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), path.join(fixture, 'Projects'));
    assert.equal(await page.locator('.map-block').count(), 2, 'folder drilldown map represents only immediate children');
    assert.deepEqual((await page.locator('.map-block .block-name').allTextContents()).sort(), ['Nested', 'README.txt'].sort());
    assert.equal(await page.evaluate(() => document.documentElement.dataset.detailsVisible), 'false', 'map drilldown does not unexpectedly open details');
    assert.ok(await page.locator('.inspector').evaluate(n => getComputedStyle(n).display === 'none'), 'hidden inspector stays collapsed through drilldown');
    const gridColumns = await page.locator('#file-list').evaluate(n => getComputedStyle(n).gridTemplateColumns.split(' ').length);
    assert.ok(gridColumns >= 2, `grid view retains multiple columns after drilldown (${gridColumns})`);
    assert.equal((await page.evaluate(p => window.fxplorer.cachedScan(p), fixture)).totalSize, rootSize, 'parent cached measurement remains available after drilldown');
    await page.locator('#back').click();
    await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), fixture);
    await page.locator('.file-row').filter({ hasText: 'Design' }).dblclick();
    await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), path.join(fixture, 'Design'));
    assert.equal(await page.locator('.map-block .block-name').textContent(), 'layout.psd', 'double-clicking a later grid tile opens its own cached contents');
    assert.equal(await page.locator('#ios-toggle-details').getAttribute('aria-expanded'), 'false', 'grid double-click leaves the inspector collapsed');
    const diagnostics = await fs.readFile(path.join(profile, 'diagnostics.log'), 'utf8');
    assert.equal([...diagnostics.matchAll(/"event":"scan-start"/g)].length, 1, 'cached navigation and restart did not trigger another scan');
    assert.deepEqual(errors, [], 'workspace interaction produces no renderer errors');
    console.log('iOS workspace interaction smoke passed: defaults, grid/list, path edit, theme roundtrip, tabs, detail pane visibility/width, cached immediate-child drilldown.');
  } finally { await app.close().catch(() => {}); }
}

async function ready(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
}

async function setTheme(page, theme) {
  await page.locator('#settings-button').click();
  await page.locator(`[data-theme-choice="${theme}"]`).click();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  await page.locator('#close-settings').click();
}

async function structure(page, ids) {
  return page.evaluate(keys => ({
    ids: Object.fromEntries(keys.map(id => [id, document.querySelectorAll(`#${id}`).length])),
    cards: ['.ios-sidebar-card', '.ios-main-card', '.ios-inspector-card'].map(selector => document.querySelectorAll(selector).length),
    controls: [...document.querySelectorAll('button, input, select')].length
  }), ids);
}

async function assertStructure(page, expected, ids, label) {
  assert.deepEqual(await structure(page, ids), expected, `${label} theme keeps composed workspace and controls intact`);
}

async function assertCoreControls(page, ids, label) {
  for (const id of ids.filter(id => !id.startsWith('ios-'))) assert.equal(await page.locator(`#${id}`).count(), 1, `${label} retains #${id}`);
  assert.equal(await page.locator('.settings-dialog').count(), 1, `${label} retains one settings dialog`);
  assert.equal(await page.locator('.ios-main-card, .ios-sidebar-card, .ios-inspector-card').count(), 0, `${label} does not leave detached iOS wrappers behind`);
}

async function makeFixture(folder) {
  await fs.mkdir(path.join(folder, 'Projects', 'Nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'README.txt'), 'workspace root readme');
  await fs.writeFile(path.join(folder, 'Projects', 'README.txt'), 'project readme');
  await fs.writeFile(path.join(folder, 'Projects', 'Nested', 'deep.txt'), 'nested file');
  for (const [dir, name, bytes] of [['Media', 'photo.png', 24000], ['Archives', 'backup.zip', 17000], ['Design', 'layout.psd', 9000]]) {
    await fs.mkdir(path.join(folder, dir), { recursive: true });
    await fs.writeFile(path.join(folder, dir, name), Buffer.alloc(bytes, 65));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
