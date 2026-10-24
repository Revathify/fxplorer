'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const workerPath = path.join(__dirname, 'scan-worker.cjs');
const TEXT_LIMIT = 128 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

function extensionOf(name) { return path.extname(name).toLowerCase(); }

async function listDirectory(inputPath) {
  const directory = path.resolve(inputPath);
  const entries = [];
  let truncated = false;
  const stream = await fs.promises.opendir(directory, { bufferSize: 64 });
  for await (const item of stream) {
    if (entries.length >= 50000) { truncated = true; break; }
    const name = item.name;
    const fullPath = path.join(directory, name);
    try {
      const stat = await fs.promises.lstat(fullPath);
      const isSymlink = stat.isSymbolicLink();
      entries.push({ name, path: fullPath, isDirectory: !isSymlink && stat.isDirectory(), isSymlink, size: stat.isDirectory() ? 0 : stat.size, modified: stat.mtime.toISOString(), extension: extensionOf(name) });
    } catch { /* an entry may disappear or become inaccessible between readdir and lstat */ }
  }
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name));
  return { path: directory, parent: path.dirname(directory) === directory ? null : path.dirname(directory), entries, truncated };
}

function scanDirectory(inputPath, { onProgress, signal, maxEntries = 250000, retainDepth = 4, cacheDirectory, spawnWorker } = {}) {
  const directory = path.resolve(inputPath);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return Promise.reject(new RangeError('maxEntries must be a positive safe integer'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { const error = new Error('The operation was aborted'); error.name = 'AbortError'; reject(error); return; }
    const workerData = { path: directory, maxEntries, retainDepth, cacheDirectory };
    const worker = spawnWorker ? spawnWorker(workerData) : new Worker(workerPath, { workerData, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const abort = () => { if (settled) return; const error = new Error('The operation was aborted'); error.name = 'AbortError'; settled = true; cleanup(); worker.terminate().then(() => reject(error), () => reject(error)); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (message.type === 'progress') { try { onProgress?.(message.data); } catch { /* UI callbacks must not stop a scan */ } }
      else if (message.type === 'result') { finish(resolve, message.data); worker.terminate().catch(() => {}); }
      else if (message.type === 'error') { const error = new Error(message.error.message); error.code = message.error.code; finish(reject, error); worker.terminate().catch(() => {}); }
    });
    worker.on('error', error => finish(reject, error instanceof Error ? error : new Error('The scan process stopped unexpectedly. Please try a smaller folder.')));
    worker.on('exit', code => { if (!settled) finish(reject, new Error(`Analysis process stopped (code ${code}). Try a smaller folder or a lower analysis limit in Settings.`)); });
  });
}

async function previewFile(inputPath) {
  const filePath = path.resolve(inputPath);
  const stat = await fs.promises.lstat(filePath);
  if (stat.isDirectory()) throw new Error('Cannot preview a directory');
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: 'none', size: stat.size };
  const ext = extensionOf(filePath);
  if (Object.hasOwn(IMAGE_TYPES, ext)) {
    if (stat.size > IMAGE_LIMIT) return { kind: 'none', size: stat.size };
    const content = await readBounded(filePath, IMAGE_LIMIT);
    if (!content) return { kind: 'none', size: stat.size };
    return { kind: 'image', content: content.toString('base64'), mime: IMAGE_TYPES[ext], size: stat.size };
  }
  if (ext === '.svg') return { kind: 'none', size: stat.size };
  if (stat.size > TEXT_LIMIT) return { kind: 'none', size: stat.size };
  const content = await readBounded(filePath, TEXT_LIMIT);
  if (!content) return { kind: 'none', size: stat.size };
  if (content.includes(0)) return { kind: 'none', size: stat.size };
  return { kind: 'text', content: content.toString('utf8'), truncated: false, size: stat.size };
}

async function readBounded(filePath, limit) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) return null;
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function validateChildName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[\\/:<>"|?*]/.test(name) || /[\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) return false;
  return true;
}

async function getDrives() {
  if (process.platform !== 'win32') return [];
  const script = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress';
  let stdout;
  try { ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10000 })); }
  catch { return []; }
  if (!stdout.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  if (!parsed) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(drive => ({ path: drive.DeviceID + '\\', label: drive.VolumeName || 'Local Disk', total: Number(drive.Size) || 0, free: Number(drive.FreeSpace) || 0 }));
}

module.exports = { listDirectory, scanDirectory, previewFile, validateChildName, getDrives };
