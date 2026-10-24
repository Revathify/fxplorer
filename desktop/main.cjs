const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, utilityProcess } = require('electron');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const engine = require('./filesystem.cjs');
const { ScanCache, containsPath } = require('./scan-cache.cjs');
const iosPreview = app.getVersion().includes('-ios-preview');
if (iosPreview && !app.commandLine.getSwitchValue('user-data-dir')) {
  const previewData = path.join(app.getPath('appData'), 'fxplorer-ios-preview');
  syncFs.mkdirSync(previewData, { recursive: true });
  app.setPath('userData', previewData);
  app.setPath('sessionData', previewData);
}
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });

let window;
let scanController;
let scanId = 0;
let copiedPath = null;
let copying = false;
let scanCache;
let activeScanRoot;
let scanFinished = Promise.resolve();
let clearingCache = false;
const uiPath = path.join(__dirname, '../ui/index.html');
function log(event, details = {}) {
  try {
    const filename = path.join(app.getPath('userData'), 'diagnostics.log');
    syncFs.mkdirSync(path.dirname(filename), { recursive: true });
    if (syncFs.existsSync(filename) && syncFs.statSync(filename).size > 1024 * 1024) syncFs.writeFileSync(filename, '');
    syncFs.appendFileSync(filename, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n');
  } catch {}
}
process.on('uncaughtException', error => { log('main-error', { message: error.message, stack: error.stack }); dialog.showErrorBox('fxplorer encountered an error', 'The error was saved in the local diagnostics log. Please restart fxplorer.'); app.quit(); });
process.on('unhandledRejection', error => log('unhandled-rejection', { message: String(error) }));
app.on('child-process-gone', (_event, details) => log('child-process-gone', { type: details.type, name: details.name, reason: details.reason, exitCode: details.exitCode }));

function localPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) || /^\\\\[.?]\\/.test(value)) {
    throw new Error('Choose an absolute folder or file path.');
  }
  return path.normalize(value);
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(uiPath).href) {
      throw new Error('Untrusted request.');
    }
    return callback(...args);
  });
}

async function cachedReport(target) {
  try {
    const report = await scanCache.lookup(target);
    if (!report || !Array.isArray(report.children) || !Array.isArray(report.categories) || !Array.isArray(report.largestFiles) || !Number.isFinite(report.totalSize)) return null;
    return report;
  } catch (error) { log('cache-read-failed', { message: error.message }); return null; }
}
async function stopScanFor(target) {
  if (scanController && activeScanRoot && (containsPath(activeScanRoot, target) || containsPath(target, activeScanRoot))) {
    const finished = scanFinished;
    scanController.abort();
    await finished;
  }
}
async function invalidateCache(target) {
  try { await scanCache.invalidate(target); } catch (error) { log('cache-invalidate-failed', { message: error.message }); }
}

function registerHandlers() {
  handle('bootstrap', async () => {
    const places = [];
    for (const [id, label] of [['home', 'Home'], ['desktop', 'Desktop'], ['downloads', 'Downloads'], ['documents', 'Documents'], ['pictures', 'Pictures'], ['videos', 'Videos'], ['music', 'Music']]) {
      const target = app.getPath(id);
      if (await fs.stat(target).then(s => s.isDirectory()).catch(() => false)) places.push({ id, label, path: target });
    }
    return { places, drives: await engine.getDrives(), version: app.getVersion(), platform: process.platform, edition: iosPreview ? 'ios-preview' : 'standard' };
  });
  handle('list', async p => { const target = localPath(p); const listing = await engine.listDirectory(target); listing.scan = await cachedReport(target); return listing; });
  handle('cached-scan', p => cachedReport(localPath(p)));
  handle('cache-info', async () => ({ ...await scanCache.info(), scans: await scanCache.recent() }));
  handle('reveal-cache', async () => { await fs.mkdir(scanCache.baseDirectory, { recursive: true }); const error = await shell.openPath(scanCache.baseDirectory); if (error) throw new Error(error); return true; });
  handle('clear-cache', async () => {
    clearingCache = true;
    try { const done = scanFinished; scanController?.abort(); await done; await scanCache.clear(); log('cache-cleared'); return await scanCache.info(); }
    finally { clearingCache = false; }
  });
  handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Explore a folder', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('scan', async (p, options = {}) => {
    if (clearingCache) throw new Error('Saved scans are being cleared. Please try again in a moment.');
    scanController?.abort();
    const id = ++scanId;
    const controller = new AbortController();
    scanController = controller;
    let finishRun;
    scanFinished = new Promise(resolve => { finishRun = resolve; });
    let cacheSession;
    let saved = false;
    try {
      const target = localPath(p);
      activeScanRoot = target;
      const maxEntries = [100000, 250000, 1000000].includes(options?.maxEntries) ? options.maxEntries : 250000;
      const retainDepth = [3, 4, 6].includes(options?.retainDepth) ? options.retainDepth : 4;
      let cacheFailure;
      try { cacheSession = await scanCache.create(target, { retainDepth }); } catch (error) { cacheFailure = error.message; log('cache-create-failed', { message: error.message }); }
      log('scan-start', { scanId: id, drive: path.parse(target).root, maxEntries, retainDepth });
      const result = await engine.scanDirectory(target, { signal: controller.signal, maxEntries, retainDepth, cacheDirectory: cacheSession?.directory, spawnWorker: data => {
        const child = utilityProcess.fork(path.join(__dirname, 'scan-process.cjs'), [JSON.stringify(data)], { serviceName: 'fxplorer storage scanner', stdio: 'pipe', execArgv: ['--max-old-space-size=128'] });
        let terminateRequested = false;
        let exited = false;
        const completion = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
        child.once('spawn', () => { if (terminateRequested) child.kill(); });
        child.terminate = async () => { terminateRequested = true; if (child.pid) child.kill(); if (!exited) await completion; };
        child.stderr?.on('data', chunk => log('scanner-stderr', { message: chunk.toString().slice(0, 2000) }));
        return child;
      }, onProgress: progress => {
        if (!window.isDestroyed() && id === scanId) window.webContents.send('scan-progress', { ...progress, scanId: id });
      } });
      if (cacheSession && result.cacheInfo) {
        try {
          await scanCache.complete(cacheSession.directory);
          saved = true;
          result.snapshot = { root: target, scannedAt: result.cacheInfo.scannedAt, retainDepth, limited: result.cacheInfo.limited, bundleId: cacheSession.id, stale: false };
        } catch (error) { result.cacheError = error.message; }
      }
      if (cacheFailure) result.cacheError = cacheFailure;
      log('scan-complete', { scanId: id, fileCount: result.fileCount, scannedEntries: result.scannedEntries, durationMs: result.durationMs, truncated: result.truncated });
      return { result, scanId: id };
    } catch (error) {
      if (error.name === 'AbortError') { log('scan-canceled', { scanId: id }); return { canceled: true, scanId: id }; }
      log('scan-failed', { scanId: id, message: error.message });
      throw error;
    } finally {
      if (cacheSession && !saved) await scanCache.discard(cacheSession.directory).catch(error => log('cache-discard-failed', { message: error.message }));
      if (id === scanId) { scanController = null; activeScanRoot = null; }
      finishRun();
    }
  });
  handle('cancel-scan', () => { scanController?.abort(); return true; });
  handle('appearance', theme => {
    const paletteBases = { 'nox-amethyst': '#141414', 'neon-maritime': '#0038BD', 'obsidian-orchid': '#303030', 'obsidian-guava': '#4C1413', 'resolute-vermilion': '#2E4C8C', 'mulberry-marina': '#34151B', 'obsidian-neon': '#0C0E09' };
    if (!['dark', 'light', 'system', 'pastel', 'ios-light', 'ios-dark', ...Object.keys(paletteBases)].includes(theme)) throw new Error('Unknown theme.');
    nativeTheme.themeSource = theme === 'ios-dark' ? 'dark' : ['pastel', 'ios-light'].includes(theme) ? 'light' : paletteBases[theme] ? 'dark' : theme;
    const dark = nativeTheme.shouldUseDarkColors;
    const background = theme === 'ios-light' ? '#f2f2f7' : theme === 'ios-dark' ? '#1c1c1e' : theme === 'pastel' ? '#f8fafc' : paletteBases[theme] || (dark ? '#13171e' : '#f5f7f9');
    window.setTitleBarOverlay({ color: background, symbolColor: dark ? '#d0d5df' : '#536273', height: 42 });
    window.setBackgroundColor(background);
    return { dark };
  });
  handle('open-diagnostics', async () => { log('diagnostics-opened'); const error = await shell.openPath(path.join(app.getPath('userData'), 'diagnostics.log')); if (error) throw new Error(error); return true; });
  handle('preview', p => engine.previewFile(localPath(p)));
  handle('open', async p => {
    const target = localPath(p);
    await fs.lstat(target);
    if (/\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msi|scr|lnk|url|hta|reg|cpl)$/i.test(target)) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Open with Windows', message: `Open “${path.basename(target)}” in its default application?`, detail: 'Windows may run this file. Only open files you trust.', buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return false;
    }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });
  handle('reveal', p => { shell.showItemInFolder(localPath(p)); return true; });
  handle('copy-path', p => { clipboard.writeText(localPath(p)); return true; });
  handle('copy', async p => { const target = localPath(p); await fs.lstat(target); copiedPath = target; return path.basename(target); });
  handle('paste', async p => {
    if (copying) throw new Error('A copy is already in progress.');
    if (!copiedPath) throw new Error('Copy a file or folder first.');
    copying = true;
    try {
    const folder = localPath(p);
    const realFolder = await fs.realpath(folder);
    const realSource = await fs.realpath(copiedPath);
    const destination = path.join(realFolder, path.basename(copiedPath));
    if (await fs.lstat(destination).then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('An item with that name already exists in the destination.');
    const relative = path.relative(realSource, destination);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Choose a destination outside the copied folder.');
    await stopScanFor(destination);
    try { await fs.cp(copiedPath, destination, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true }); }
    finally { await invalidateCache(destination); }
    return destination;
    } finally { copying = false; }
  });
  handle('rename', async (p, name) => {
    if (!engine.validateChildName(name)) throw new Error('Use a valid Windows name without reserved names or characters.');
    const source = localPath(p);
    if (source === path.parse(source).root) throw new Error('A drive cannot be renamed here.');
    const destination = path.join(path.dirname(source), name);
    if (destination === source) return source;
    if (await fs.lstat(destination).then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('An item with that name already exists.');
    await stopScanFor(source);
    await fs.rename(source, destination);
    await invalidateCache(source);
    await invalidateCache(destination);
    return destination;
  });
  handle('new-folder', async (p, name) => { if (!engine.validateChildName(name)) throw new Error('Use a valid Windows name without reserved names or characters.'); const target = path.join(localPath(p), name); await stopScanFor(target); await fs.mkdir(target); await invalidateCache(target); return target; });
  handle('trash', async p => {
    const target = localPath(p);
    if (target === path.parse(target).root || target.toLowerCase() === app.getPath('home').toLowerCase()) throw new Error('This location cannot be moved to the Recycle Bin.');
    await fs.lstat(target);
    const choice = await dialog.showMessageBox(window, { type: 'warning', title: 'Move to Recycle Bin', message: `Move “${path.basename(target)}” to the Recycle Bin?`, detail: 'You can restore it from the Windows Recycle Bin. On unsupported volumes this operation may fail.', buttons: ['Cancel', 'Move to Recycle Bin'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return false;
    await stopScanFor(target);
    await shell.trashItem(target);
    await invalidateCache(target);
    return true;
  });
  handle('export', async report => {
    if (!report || typeof report !== 'object' || JSON.stringify(report).length > 2_000_000) throw new Error('Invalid report.');
    const result = await dialog.showSaveDialog(window, { title: 'Export storage report', defaultPath: 'fxplorer-storage-report.json', filters: [{ name: 'JSON report', extensions: ['json'] }] });
    if (result.canceled) return false;
    await fs.writeFile(result.filePath, JSON.stringify({ application: 'fxplorer', version: app.getVersion(), exportedAt: new Date().toISOString(), ...report }, null, 2), { flag: 'w' });
    return true;
  });
}

if (primaryInstance) app.whenReady().then(async () => {
  log('app-start', { version: app.getVersion() });
  scanCache = new ScanCache(path.join(app.getPath('userData'), 'scan-cache', 'v1'));
  await scanCache.recover().catch(error => log('cache-recovery-failed', { message: error.message }));
  nativeTheme.themeSource = iosPreview ? 'light' : 'dark';
  Menu.setApplicationMenu(null);
  const initialBackground = iosPreview ? '#f2f2f7' : '#13171e';
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1100, minHeight: 720, backgroundColor: initialBackground, title: iosPreview ? 'fxplorer · iOS Preview' : 'fxplorer', icon: path.join(__dirname, '../assets/icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: initialBackground, symbolColor: iosPreview ? '#536273' : '#9ba5b5', height: 42 }, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  registerHandlers();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('render-process-gone', (_event, details) => { log('renderer-gone', details); if (details.reason !== 'clean-exit') dialog.showErrorBox('fxplorer window stopped', 'Please restart fxplorer. Details were saved in the local diagnostics log.'); });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => scanController?.abort());
  window.loadFile(uiPath);
});
app.on('window-all-closed', () => app.quit());
