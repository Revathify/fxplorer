const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'ios-desktop-'));
  const fixture = path.join(run, 'Workspace');
  const defaultProfile = path.join(run, 'profile');
  await makeFixture(fixture);
  const launch = profile => electron.launch({ args: [root, ...(profile ? [`--user-data-dir=${profile}`] : [])], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  const errors = [];
  const externalRequests = [];
  let app = await launch(defaultProfile);
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    assert.equal(await page.locator('html').getAttribute('data-edition'), 'ios-preview');
    const bootstrap = await page.evaluate(() => window.fxplorer.bootstrap());
    assert.equal(bootstrap.edition, 'ios-preview');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ios-light', 'fresh default profile starts with iOS light');
    assert.deepEqual(await appearance(page, app, 'ios-light'), { dark: false });
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), defaultProfile, 'explicit test profile is respected');
    assert.ok(await fs.stat(defaultProfile).then(s => s.isDirectory(), () => false), 'fresh preview profile uses its isolated app data directory');
    await page.locator('#address').fill(fixture); await page.locator('#address').press('Enter');
    await page.waitForFunction(p => document.querySelector('#address').value === p && document.querySelectorAll('.file-row').length > 0, fixture);
    await page.setViewportSize({ width: 1500, height: 960 });
    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'));
    await page.screenshot({ path: path.join(output, 'ios-desktop-light.png'), animations: 'disabled' });
    assert.equal(await page.locator('.map-block').count(), 5, 'map contains five immediate fixture children');
    const cached = await page.evaluate(p => window.fxplorer.cachedScan(p), fixture);
    assert.equal(cached.totalSize, Buffer.byteLength('iOS preview fixture readable text') + Buffer.byteLength('iOS preview fixture text\n'.repeat(1200)) + Buffer.byteLength('nested child') + 27000 + 19000 + 11000);
    assert.equal(cached.fileCount, 6);
    const visuals = await page.evaluate(() => {
      const style = node => { const s = getComputedStyle(node); return { color: s.color, background: s.backgroundColor, opacity: s.opacity }; };
      return { root: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), body: style(document.body), sidebar: style(document.querySelector('.sidebar')),
        tileColors: [...document.querySelectorAll('.map-block')].map(node => getComputedStyle(node).backgroundImage), scroll: document.documentElement.scrollWidth };
    });
    assert.ok(visuals.tileColors.length >= 3 && new Set(visuals.tileColors).size >= 3, `map has colorful distinct tiles: ${visuals.tileColors}`);
    assert.equal(visuals.body.opacity, '1');
    assert.ok(visuals.scroll <= 1500, 'wide layout fits viewport');
    assert.equal(await page.locator('.inspector').isVisible(), false, 'details stay collapsed until requested');
    await page.locator('#ios-toggle-details').click();
    await page.locator('.file-row').filter({ hasText: 'README.txt' }).click();
    await page.locator('[data-action="preview"]').click();
    await page.locator('.preview-box pre').waitFor();
    const preview = await page.locator('.preview-box pre').evaluate(n => { const s = getComputedStyle(n); return [s.color, s.backgroundColor, parseFloat(s.fontSize)]; });
    assert.match(await page.locator('.preview-box pre').textContent(), /iOS preview fixture/);
    assert.ok(preview[2] >= 10, 'preview text size is readable');
    await page.locator('#settings-button').click();
    await page.screenshot({ path: path.join(output, 'ios-settings.png'), animations: 'disabled' });
    assert.deepEqual(await page.locator('#setting-accent, #setting-glass, #setting-solid').evaluateAll(nodes => nodes.map(n => n.disabled)), [true, true, false]);
    await page.locator('#setting-solid').setChecked(true);
    assert.deepEqual(await page.evaluate(() => ['.sidebar', '.navigation'].map(selector => getComputedStyle(document.querySelector(selector)).backdropFilter)), ['none', 'none']);
    assert.equal(await page.locator('.navigation').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)', 'Solid mode has an opaque toolbar');
    await page.locator('#setting-solid').setChecked(false);
    assert.ok(await page.locator('[data-theme-choice="ios-light"]').isVisible());
    assert.ok(await page.locator('[data-theme-choice="ios-dark"]').isVisible());
    await page.locator('[data-theme-choice="ios-dark"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'ios-dark');
    await page.locator('#close-settings').click();
    await page.screenshot({ path: path.join(output, 'ios-desktop-dark.png'), animations: 'disabled' });
    assert.deepEqual(await appearance(page, app, 'ios-dark'), { dark: true });
    await page.locator('.map-block').filter({ hasText: 'Projects' }).dblclick();
    await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), path.join(fixture, 'Projects'));
    assert.equal(await page.locator('.map-block').count(), 2, 'drilldown contains only immediate children');
    assert.deepEqual((await page.locator('.map-block .block-name').allTextContents()).sort(), ['Nested', 'README.txt'].sort());
    assert.equal((await page.evaluate(p => window.fxplorer.cachedScan(p), fixture)).totalSize, cached.totalSize, 'cached parent report survives drilldown');
    const initialLeft = await page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width);
    await page.getByRole('separator', { name: 'Resize navigation panel', exact: true }).press('ArrowRight');
    await page.getByRole('separator', { name: 'Resize details panel', exact: true }).press('ArrowLeft');
    const resized = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')));
    assert.ok(resized.left >= initialLeft + 9, 'layout preference persists after resizing');
    await page.setViewportSize({ width: 1100, height: 720 });
    const narrow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, center: document.querySelector('.content').getBoundingClientRect().width }));
    assert.ok(narrow.scroll <= narrow.width, `1100×720 layout has no horizontal overflow (${narrow.scroll}px)`);
    assert.ok(narrow.center >= 560, 'center workspace retains minimum width');
    await page.setViewportSize({ width: 1500, height: 960 });
    await app.close();
    app = await launch(defaultProfile);
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ios-dark', 'appearance survives app restart');
    assert.deepEqual(await appearance(page, app, 'ios-dark'), { dark: true });
    assert.deepEqual(await page.evaluate(() => [Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), Math.round(document.querySelector('.inspector').getBoundingClientRect().width)]), [resized.left, resized.right], 'panel widths survive restart');
    await page.locator('#settings-button').click();
    await page.locator('#reset-settings').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'ios-light');
    assert.deepEqual(await appearance(page, app, 'ios-light'), { dark: false }, 'restore defaults returns to iOS light');
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, [], 'no external requests');
    assert.equal((await fs.readFile(path.join(defaultProfile, 'diagnostics.log'), 'utf8').catch(() => '')) .split('"event":"scan-start"').length - 1, 1, 'drilldown and restart reuse the original scan');

    const explicitProfile = path.join(run, 'explicit-profile');
    let explicitApp = await launch(explicitProfile);
    try {
      let explicitPage = await explicitApp.firstWindow();
      await explicitPage.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
      assert.equal(await explicitPage.evaluate(() => document.documentElement.dataset.theme), 'ios-light', 'explicit profile begins with independent defaults');
      assert.ok(await fs.stat(explicitProfile).then(s => s.isDirectory(), () => false), 'explicit profile is created');
      await explicitPage.locator('#settings-button').click();
      await explicitPage.locator('[data-theme-choice="ios-dark"]').click();
      await explicitApp.close();
      explicitApp = await launch(explicitProfile);
      explicitPage = await explicitApp.firstWindow();
      await explicitPage.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
      assert.equal(await explicitPage.evaluate(() => document.documentElement.dataset.theme), 'ios-dark', 'explicit profile settings persist in that profile');
      assert.ok(await fs.stat(path.join(explicitProfile, 'Preferences')).then(() => true, () => false), 'Chromium preferences remain inside explicit profile');
      assert.equal(await explicitPage.evaluate(() => window.fxplorer.bootstrap().then(x => x.edition)), 'ios-preview');
    } finally { await explicitApp.close(); }
    await app.close();
    app = await launch(defaultProfile);
    page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'ios-light', 'explicit profile changes do not affect the isolated default profile');
    const defaultApp = await launch(null);
    try {
      await defaultApp.firstWindow();
      const locations = await defaultApp.evaluate(({ app }) => ({ user: app.getPath('userData'), session: app.getPath('sessionData'), appData: app.getPath('appData') }));
      assert.equal(locations.user, path.join(locations.appData, 'fxplorer-ios-preview'), 'ordinary startup selects the separate preview directory');
      assert.equal(locations.session, locations.user, 'Chromium session data is isolated with preview preferences');
    } finally { await defaultApp.close(); }
    console.log('iOS preview desktop smoke passed. Screenshots: .test-output/ios-desktop-light.png, .test-output/ios-desktop-dark.png, .test-output/ios-settings.png');
  } finally { await app.close().catch(() => {}); }
}

async function makeFixture(rootPath) {
  await fs.mkdir(path.join(rootPath, 'Projects', 'Nested'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'README.txt'), 'iOS preview fixture readable text');
  for (const [folder, name, size] of [['Projects', 'README.txt', 31000], ['Media', 'photo.png', 27000], ['Archives', 'backup.zip', 19000], ['Design', 'layout.psd', 11000]]) {
    await fs.mkdir(path.join(rootPath, folder), { recursive: true });
    await fs.writeFile(path.join(rootPath, folder, name), Buffer.alloc(size, 65));
  }
  await fs.writeFile(path.join(rootPath, 'Projects', 'README.txt'), 'iOS preview fixture text\n'.repeat(1200));
  await fs.writeFile(path.join(rootPath, 'Projects', 'Nested', 'deep.txt'), 'nested child');
}

async function appearance(page, app, theme) {
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
  const appearance = await page.evaluate(value => window.fxplorer.appearance(value), theme);
  const source = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  assert.equal(source, theme === 'ios-dark' ? 'dark' : 'light');
  return appearance;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
