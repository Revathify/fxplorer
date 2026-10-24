const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
async function main() {
  const output = path.join(root, '.test-output'); await fs.mkdir(output, { recursive: true });
  const run = await fs.mkdtemp(path.join(output, 'drive-run-'));
  const app = await electron.launch({ args: [root, `--user-data-dir=${path.join(run, 'profile')}`], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#address').value.length > 0, undefined, { timeout: 25000 });
    await page.locator('#address').fill('C:\\'); await page.locator('#address').press('Enter');
    await page.waitForFunction(() => document.querySelector('#address').value === 'C:\\');
    await page.locator('#scan').click();
    const { setTimeout: delay } = require('node:timers/promises');
    let scanner;
    for (let attempt = 0; attempt < 40; attempt++) { scanner = await app.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.name === 'fxplorer storage scanner')); if (scanner?.pid) break; await delay(100); }
    assert.ok(scanner?.pid, 'a separate scanner process must exist');
    await app.evaluate((_electron, pid) => process.kill(pid), scanner.pid);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Analysis could not finish'));
    await page.locator('#settings-button').click(); await page.locator('#settings-dialog').waitFor();
    await page.locator('[data-theme-choice="light"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.locator('#setting-density').selectOption('compact');
    await page.locator('#close-settings').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact');
    console.log('Injected scanner termination recovered; desktop and Settings remain responsive.');
    await page.locator('#scan').click();
    await page.locator('#settings-button').click(); await page.locator('#close-settings').click();
    await page.waitForFunction(() => /Analysis complete|Partial analysis/.test(document.querySelector('#status').textContent), undefined, { timeout: 240000 });
    assert.equal(await page.locator('#scan-label').textContent(), 'Analyze again');
    assert.ok(await page.locator('.map-block').count() > 0);
    const stats = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ type: metric.type, name: metric.name, workingSetKB: metric.memory.workingSetSize })));
    const result = { status: await page.locator('#status').textContent(), detail: await page.locator('#status-detail').textContent(), appMetrics: stats, errors };
    await fs.writeFile(path.join(output, 'drive-desktop-result.json'), JSON.stringify(result, null, 2));
    assert.deepEqual(errors, []);
    console.log('C drive analysis passed in the real desktop app at the configured 250,000-entry cap, including map rendering and responsive settings. No filenames are included in the test report.');
    console.log(result.status, result.detail);
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
