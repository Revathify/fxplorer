const { _electron: electron, chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');

// The NSIS portable wrapper does not forward the child application's debugger stdout.
// Connect to Chromium through its ephemeral local port instead of treating the wrapper as Electron.
async function launchPortable(executablePath, profile) {
  const process = spawn(executablePath, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  process.on('error', error => { spawnError = error; });
  let browser;
  const start = Date.now();
  try {
    while (Date.now() - start < 40000) {
      if (spawnError) throw spawnError;
      const port = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then(text => Number(text.split('\n')[0])).catch(() => null);
      if (port) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); break; } catch {} }
      await delay(150);
    }
    if (!browser) throw new Error('Portable launcher did not start a debuggable desktop window.');
    const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].waitForEvent('page');
    return { page, close: async () => {
      // Chromium can exit before replying to Browser.close. Keep an exit deadline
      // alive instead of awaiting a CDP response that will never arrive.
      const exited = process.exitCode !== null || process.signalCode !== null ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Portable wrapper did not exit after closing the app.')), 20000);
        process.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      if (browser.isConnected()) {
        try { const session = await browser.newBrowserCDPSession(); session.send('Browser.close').catch(() => {}); } catch {}
      }
      await exited;
    } };
  } catch (error) { process.kill(); throw error; }
}

async function main() {
  const output = path.join(root, '.test-output');
  await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'packaged-run-'));
  const fixture = path.join(run, 'Packaged check');
  const deepFolder = path.join(fixture, 'nested', 'second', 'third', 'fourth');
  await fs.mkdir(deepFolder, { recursive: true });
  await fs.writeFile(path.join(deepFolder, 'notes.txt'), 'Packaged worker test');
  await fs.writeFile(path.join(fixture, 'sample.json'), '{"local":true}');
  const version = require('../package.json').version;
  const targets = [['unpacked', path.join(root, 'dist', 'win-unpacked', 'fxplorer.exe')], ['portable', path.join(root, 'dist', `fxplorer-${version}-win-x64.exe`)]].filter(([label]) => (!process.argv.includes('--portable-only') || label === 'portable') && (!process.argv.includes('--unpacked-only') || label === 'unpacked'));
  for (const [label, executablePath] of targets) {
    const profile = path.join(run, label + '-profile');
    const launch = () => label === 'portable' ? launchPortable(executablePath, profile) : electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], timeout: 30000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    let app = await launch();
    try {
      let page = app.page || await app.firstWindow();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => document.querySelector('#address').value.length > 0, undefined, { timeout: 25000 });
      assert.equal(await page.evaluate(() => window.fxplorer.bootstrap().then(x => x.version)), version);
      await page.locator('#address').fill(fixture); await page.locator('#address').press('Enter');
      await page.waitForFunction(p => document.querySelector('#address').value === p, fixture);
      await page.locator('#scan').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis complete'));
      assert.equal(await page.locator('.map-block').count(), 2);
      const result = await page.evaluate(p => window.fxplorer.cachedScan(p), fixture);
      assert.equal(result.totalSize, Buffer.byteLength('Packaged worker test') + Buffer.byteLength('{"local":true}'));
      assert.equal(result.fileCount, 2);
      assert.equal(await page.locator('.map-subtile').count(), 0);
      await page.locator('.map-block').filter({ hasText: 'nested' }).dblclick();
      await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), path.join(fixture, 'nested'));
      assert.equal(await page.locator('.map-block .block-name').textContent(), 'second');
      assert.equal(await page.locator('#snapshot-badge').isVisible(), true);
      await page.locator('#address').fill(fixture); await page.locator('#address').press('Enter');
      await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), fixture);
      if (await page.locator('#ios-toggle-details').count()) await page.locator('#ios-toggle-details').click();
      await page.locator('.file-row').filter({ hasText: 'sample.json' }).click();
      await page.locator('[data-action="preview"]').click();
      await page.locator('.preview-box pre').waitFor();
      assert.equal(await page.locator('.preview-box pre').textContent(), '{"local":true}');
      const edition = await page.evaluate(() => window.fxplorer.bootstrap().then(x => x.edition));
      const previewEdition = edition === 'ios-preview';
      let persistedTheme = 'pastel';
      await page.locator('#settings-button').click();
      if (previewEdition) {
        await page.locator('[data-theme-choice="ios-dark"]').click();
        assert.deepEqual(await page.evaluate(() => window.fxplorer.appearance('ios-dark')), { dark: true });
        await page.locator('[data-theme-choice="ios-light"]').click();
        assert.deepEqual(await page.evaluate(() => window.fxplorer.appearance('ios-light')), { dark: false });
        persistedTheme = 'ios-light';
      } else {
        await page.locator('[data-theme-choice="obsidian-orchid"]').click();
        await page.locator('#setting-glass').selectOption('5');
        await page.locator('[data-theme-choice="pastel"]').click();
      }
      await page.locator('#close-settings').click();
      await page.getByRole('separator', { name: 'Resize navigation panel', exact: true }).press('ArrowRight');
      await page.getByRole('separator', { name: 'Resize details panel', exact: true }).press('ArrowLeft');
      const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('fxplorer-layout')));
      assert.deepEqual(await page.evaluate(theme => window.fxplorer.appearance(theme), persistedTheme), { dark: false });
      if (!previewEdition) assert.ok(await page.evaluate(async () => (await document.fonts.load('600 16px "Nunito Local"')).length > 0), 'bundled Pastel font loads from app.asar');
      await app.close();
      app = await launch();
      page = app.page || await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      await page.waitForFunction(() => document.querySelector('#address').value.length > 0, undefined, { timeout: 25000 });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), persistedTheme);
      if (!previewEdition) assert.equal(await page.evaluate(() => document.documentElement.dataset.glassLevel), '5');
      assert.deepEqual(await page.evaluate(() => [Math.round(document.querySelector('.sidebar').getBoundingClientRect().width), Math.round(document.querySelector('.inspector').getBoundingClientRect().width)]), [layout.left, layout.right], 'both panel widths survive packaged app restart');
      await page.locator('#address').fill(deepFolder); await page.locator('#address').press('Enter');
      await page.waitForFunction(p => document.querySelector('#address').value === p && !document.body.classList.contains('loading'), deepFolder);
      assert.equal(await page.locator('#snapshot-badge').isVisible(), true);
      assert.equal(await page.locator('.map-block .block-name').textContent(), 'notes.txt');
      const log = await fs.readFile(path.join(profile, 'diagnostics.log'), 'utf8');
      assert.equal([...log.matchAll(/"event":"scan-start"/g)].length, 1, 'packaged restart and drilldown must reuse the original saved scan');
      await page.screenshot({ path: path.join(output, `fxplorer-${label}-saved.png`), animations: 'disabled' });
      assert.deepEqual(errors, []);
      console.log(`${label} EXE passed: launch, isolated preload, scanner from app.asar, byte totals, map drilldown, text preview, ${previewEdition ? 'iOS light/dark appearances' : 'Pastel/native light and bundled font'}, saved panel widths, and four-level saved restore after restart without rescanning.`);
    } finally { await app.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
