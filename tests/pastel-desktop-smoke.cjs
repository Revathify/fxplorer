const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'pastel-desktop-'));
  const fixture = path.join(run, 'Pastel workspace');
  const profile = path.join(run, 'profile');
  await makeFixture(fixture);
  const launch = () => electron.launch({ args: [root, `--user-data-dir=${profile}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  const errors = [];
  const externalRequests = [];
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
    await page.waitForFunction(() => document.querySelector('#address')?.value.length > 0, undefined, { timeout: 25000 });
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined', 'renderer has no Node integration');
    await page.locator('#address').fill(fixture);
    await page.locator('#address').press('Enter');
    await page.waitForFunction(p => document.querySelector('#address').value === p && document.querySelectorAll('.file-row').length > 0, fixture);
    await page.setViewportSize({ width: 1500, height: 960 });

    await page.locator('#settings-button').click();
    const edition = await page.locator('html').getAttribute('data-edition');
    const pastelChoice = 'pastel';
    await page.locator(`[data-theme-choice="${pastelChoice}"]`).click();
    await page.locator('#setting-startup').selectOption('last');
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, pastelChoice);
    assert.deepEqual(await appearance(page, app), [pastelChoice, false, 'light'], 'light renderer choice and native light appearance agree');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), pastelChoice);
    assert.deepEqual(await page.evaluate(async () => {
      const loaded = await document.fonts.load('600 16px "Nunito Local"');
      const body = getComputedStyle(document.body).fontFamily;
      return [loaded.length > 0, document.fonts.check('600 16px "Nunito Local"'), body];
    }).then(([loaded, checked, family]) => [loaded, checked, family.includes('Nunito Local')]), [true, true, true], 'local Nunito font loads and is used');
    assert.deepEqual(await page.locator('#setting-accent, #setting-glass, #setting-solid').evaluateAll(nodes => nodes.map(node => node.disabled)), [true, true, true], 'glass/accent settings are disabled for the solid light theme');
    assert.equal(await page.locator('#pastel-note').isVisible(), true);
    await page.locator('#close-settings').click();

    await page.locator('#scan').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'));
    assert.equal(await page.locator('.map-block').count(), 8, 'map contains only the eight immediate children');
    const themeVisuals = await page.evaluate(() => {
      const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(channel => Number(channel) * (value.startsWith('color(srgb') ? 255 : 1));
      const vars = getComputedStyle(document.documentElement);
      const selectors = ['.sidebar', '.inspector', '.treemap', '.map-block', '.map-legend', '.button.primary'];
      const styles = selectors.map(selector => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        return { selector, background: rgb(style.backgroundColor), color: rgb(style.color), opacity: style.opacity };
      });
      return { bg: vars.getPropertyValue('--bg').trim(), text: vars.getPropertyValue('--text').trim(), styles,
        mapBg: getComputedStyle(document.querySelector('.treemap')).backgroundColor,
        legend: [...document.querySelectorAll('#map-legend .legend-dot')].map(node => getComputedStyle(node).backgroundColor),
        blocks: [...document.querySelectorAll('.map-block')].map(node => getComputedStyle(node).backgroundColor),
        columns: [...document.querySelector('.workspace').children].slice(0, 3).map(node => Math.round(node.getBoundingClientRect().width)),
        scroll: document.documentElement.scrollWidth };
    });
    await page.screenshot({ path: path.join(output, 'pastel-desktop.png'), animations: 'disabled' });
    assert.equal(themeVisuals.bg, '#f2f7f3');
    assert.ok(themeVisuals.styles.every(item => item.opacity === '1'), 'key panels and controls are opaque');
    assert.ok(themeVisuals.styles.filter(item => item.selector !== '.button.primary').every(item => luminance(item.color) < 0.45), `panel and map text is dark: ${JSON.stringify(themeVisuals.styles)}`);
    assert.ok(themeVisuals.blocks.every(value => isSoft(rgb(value))), `map tiles are pastel rather than saturated: ${themeVisuals.blocks.join(', ')}`);
    assert.ok(themeVisuals.legend.length >= 3 && themeVisuals.legend.every(value => isSoft(rgb(value))), 'legend markers use the softened map palette');
    assert.ok(themeVisuals.scroll <= 1500, `wide viewport has no horizontal overflow (${themeVisuals.scroll}px)`);
    await page.screenshot({ path: path.join(output, 'pastel-desktop.png'), animations: 'disabled' });

    await page.locator('.map-block').filter({ hasText: 'Projects' }).click();
    assert.equal(await page.locator('.map-block.selected').count(), 1, 'map selection is visible');
    await page.locator('.file-row').filter({ hasText: 'root.txt' }).click();
    assert.equal(await page.locator('.file-row.selected').count(), 1, 'file selection is visible');
    assert.ok(await page.locator('.detail-name').textContent().then(text => text.includes('root.txt')));
    await page.locator('[data-action="preview"]').click();
    await page.locator('.preview-box pre').waitFor();
    assert.match(await page.locator('.preview-box pre').textContent(), /Root-level fixture file/);
    const readable = await page.locator('.preview-box pre').evaluate(node => {
      const s = getComputedStyle(node);
      return [s.color, s.backgroundColor, parseFloat(s.fontSize)];
    });
    assert.ok(luminance(rgb(readable[0])) < 0.45, `preview text is dark: ${readable[0]}`);
    assert.ok(readable[2] >= 10, `preview font remains readable (${readable[2]}px)`);

    await page.locator('#new-folder').click();
    assert.equal(await page.locator('#name-dialog').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.locator('#name-input').fill('Canceled folder');
    await page.locator('#dialog-cancel').click();
    assert.equal(await fs.stat(path.join(fixture, 'Canceled folder')).then(() => true, () => false), false, 'cancel does not create folder');

    const initial = await columns(page);
    const left = page.locator('[data-layout-side="left"]');
    const leftBox = await left.boundingBox();
    await page.mouse.move(leftBox.x + 4, 240); await page.mouse.down();
    await page.mouse.move(leftBox.x + 50, 240, { steps: 4 }); await page.mouse.up();
    assert.ok((await columns(page))[0] > initial[0] + 25, 'drag resizes the sidebar');
    const right = page.locator('[data-layout-side="right"]');
    const rightBox = await right.boundingBox();
    await page.mouse.move(rightBox.x + 4, 240); await page.mouse.down();
    await page.mouse.move(rightBox.x - 42, 240, { steps: 4 }); await page.mouse.up();
    assert.ok((await columns(page))[2] > initial[2] + 20, 'drag resizes inspector');
    const mapBounds = await page.locator('#treemap').evaluate(node => {
      const rect = node.getBoundingClientRect(); const middle = document.querySelector('.content').getBoundingClientRect();
      return [rect.left >= middle.left, rect.right <= middle.right, rect.width, rect.height];
    });
    assert.deepEqual(mapBounds.slice(0, 2), [true, true], 'map redraw stays within the resized middle column');

    await page.setViewportSize({ width: 1100, height: 720 });
    const narrow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, columns: [...document.querySelector('.workspace').children].slice(0, 3).map(node => node.getBoundingClientRect().width) }));
    assert.ok(narrow.scroll <= narrow.width, `1100×720 viewport has no overflow (${narrow.scroll}px)`);
    assert.ok(narrow.columns[1] >= 560, 'map column retains its minimum width');
    await page.setViewportSize({ width: 1500, height: 960 });

    const before = await page.locator('#address').inputValue();
    await page.locator('.map-block').filter({ hasText: 'Projects' }).dblclick();
    await page.waitForFunction(p => document.querySelector('#address').value === p, path.join(fixture, 'Projects'));
    assert.equal(await page.locator('.map-block').count(), 2, 'drilldown map shows only the selected folder immediate children');
    assert.deepEqual((await page.locator('.map-block .block-name').allTextContents()).sort(), ['Nested notes', 'README.md'].sort());
    assert.notEqual(await page.locator('#address').inputValue(), before);
    await page.locator('#back').click();
    await page.waitForFunction(p => document.querySelector('#address').value === p, fixture);
    assert.equal(await page.locator('.map-block').count(), 8, 'back returns to the eight-item parent map');
    await page.evaluate(() => { document.querySelector('.sidebar').scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'pastel-layout-desktop.png'), animations: 'disabled' });

    await page.locator('#settings-button').click();
    await page.screenshot({ path: path.join(output, 'pastel-settings.png'), animations: 'disabled' });
    assert.deepEqual(await page.locator('#setting-accent, #setting-glass, #setting-solid').evaluateAll(nodes => nodes.map(node => node.disabled)), [true, true, true]);
    await page.locator('#close-settings').click();
      await page.reload();
    await page.waitForFunction(p => document.querySelector('#address').value === p, fixture);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), pastelChoice, 'light theme persists on renderer reload');
    assert.deepEqual(await appearance(page, app), [pastelChoice, false, 'light']);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
    await page.waitForFunction(p => document.querySelector('#address')?.value === p, fixture, { timeout: 25000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), pastelChoice, 'light theme persists across application restart');
    assert.deepEqual(await appearance(page, app), [pastelChoice, false, 'light']);
    await page.locator('#settings-button').click();
    const darkChoice = 'nox-amethyst';
    await page.locator(`[data-theme-choice="${darkChoice}"]`).click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, darkChoice);
    assert.deepEqual(await page.evaluate(() => [window.fxSettings.theme, window.fxSettings.accent, window.fxSettings.glassLevel, window.fxSettings.solidPanels]), [darkChoice, 'mint', 3, false], 'switch back preserves glass preferences');
    assert.deepEqual(await page.locator('#setting-accent, #setting-glass, #setting-solid').evaluateAll(nodes => nodes.map(node => node.disabled)), [false, false, false], 'glass controls re-enable');
    assert.deepEqual(await appearance(page, app), [darkChoice, true, 'dark']);
    await page.locator('#reset-settings').click();
    const defaultChoice = edition === 'ios-preview' ? 'ios-light' : 'dark';
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, defaultChoice);
    assert.deepEqual(await appearance(page, app), [defaultChoice, edition !== 'ios-preview', edition === 'ios-preview' ? 'light' : 'dark'], 'restore defaults resets native appearance');
    assert.deepEqual(errors, [], 'no renderer uncaught exceptions');
    assert.deepEqual(externalRequests, [], 'no external network connections are attempted');
    console.log(`Pastel desktop smoke passed: light theme/native appearance, readable UI, map/legend, selection/preview, dialog cancellation, resizing and viewport fit, direct-child drilldown/back, persistence, glass return and default restore.`);
    console.log('Screenshots: .test-output/pastel-desktop.png, .test-output/pastel-settings.png');
  } finally { await app.close().catch(() => {}); }
}

async function makeFixture(rootPath) {
  await fs.mkdir(path.join(rootPath, 'Projects', 'Nested notes'), { recursive: true });
  for (const [folder, name, size] of [
    ['Projects', 'README.md', 48000], ['Media', 'photo.png', 34000], ['Archives', 'backup.zip', 24000],
    ['Documents', 'report.pdf', 16000], ['Design', 'layout.psd', 9000], ['Audio', 'theme.flac', 4000]
  ]) {
    await fs.mkdir(path.join(rootPath, folder), { recursive: true });
    await fs.writeFile(path.join(rootPath, folder, name), folder === 'Projects' ? 'Pastel fixture text\nReadable preview content.\n'.repeat(1200) : Buffer.alloc(size, 65));
  }
  await fs.writeFile(path.join(rootPath, 'Projects', 'Nested notes', 'deep.txt'), 'Only appears after opening Projects.');
  await fs.writeFile(path.join(rootPath, 'root.txt'), 'Root-level fixture file.');
  await fs.writeFile(path.join(rootPath, 'index.json'), '{"fixture":true,"theme":"pastel"}');
}

async function appearance(page, app) {
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const result = await page.evaluate(value => window.fxplorer.appearance(value), theme);
  const source = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  return [theme, result.dark, source];
}

async function columns(page) { return page.evaluate(() => [...document.querySelector('.workspace').children].slice(0, 3).map(node => Math.round(node.getBoundingClientRect().width))); }
function rgb(value) { return (value.match(/[\d.]+/g) || []).slice(0, 3).map(channel => Number(channel) * (value.startsWith('color(srgb') ? 255 : 1)); }
function luminance([r, g, b]) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function isSoft([r, g, b]) { return Math.max(r, g, b) > 175 && Math.min(r, g, b) > 125 && Math.max(r, g, b) - Math.min(r, g, b) < 110; }

main().catch(error => { console.error(error); process.exitCode = 1; });
