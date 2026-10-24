'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const MiB = 1024 * 1024;
const MAX_JSON_BYTES = 8 * MiB;
const MAX_MANIFEST_BYTES = 128 * 1024;
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathKey(value) {
  let normalized = path.normalize(path.resolve(String(value)));
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function containsPath(parent, candidate) {
  const parentKey = pathKey(parent);
  const candidateKey = pathKey(candidate);
  const relative = path.relative(parentKey, candidateKey);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourceIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function identityMatches(expected, actual) {
  if (!expected) return true;
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeMs === actual.birthtimeMs;
}

async function boundedRead(filePath, maxBytes) {
  let handle;
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
    handle = await fs.open(filePath, 'r');
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'EINVAL', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(filePath, data) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: 'wx' });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validIdentity(identity) {
  return identity && typeof identity === 'object'
    && Number.isFinite(identity.dev) && Number.isFinite(identity.ino)
    && Number.isFinite(identity.birthtimeMs);
}

function validManifest(manifest) {
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.schema === 1 && typeof manifest.root === 'string' && path.isAbsolute(manifest.root)
    && typeof manifest.scannedAt === 'string' && Number.isFinite(Date.parse(manifest.scannedAt))
    && Number.isInteger(manifest.retainDepth) && manifest.retainDepth >= 0
    && Number.isInteger(manifest.snapshotCount) && manifest.snapshotCount >= 0
    && Number.isFinite(manifest.bytes) && manifest.bytes >= 0
    && typeof manifest.limited === 'boolean' && manifest.complete === true
    && (manifest.sourceIdentity == null || validIdentity(manifest.sourceIdentity));
}

class SnapshotWriter {
  constructor(directory, {
    root,
    retainDepth = 4,
    scannedAt = new Date().toISOString(),
    sourceIdentity: identity,
    maxBytes = 64 * MiB,
    maxSnapshots = 5000,
  } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(path.resolve(root))) throw new TypeError('Snapshot writer requires an absolute root path');
    this.directory = path.resolve(directory);
    this.root = path.resolve(root);
    this.rootKey = pathKey(this.root);
    this.retainDepth = Math.max(0, Math.floor(retainDepth));
    this.scannedAt = scannedAt;
    this.sourceIdentity = identity;
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.maxSnapshots = Math.max(1, Math.floor(Number(maxSnapshots) || 1));
    this.bytes = 0;
    this.snapshotCount = 0;
    this.limited = false;
    this.finished = false;
  }

  async write(report, { isRoot = false } = {}) {
    if (this.finished) throw new Error('Snapshot writer is already finished');
    if (!report || typeof report.path !== 'string') throw new TypeError('Snapshot report must include a path');
    const reportPath = path.resolve(report.path);
    if (!containsPath(this.root, reportPath)) throw new Error('Snapshot path is outside the scan root');
    const relative = path.relative(this.root, reportPath);
    const depth = relative ? relative.split(path.sep).filter(Boolean).length : 0;
    const rootReport = isRoot || pathKey(reportPath) === this.rootKey;
    if (!rootReport && depth > this.retainDepth) { this.limited = true; return false; }
    const nonRootSnapshotLimit = Math.max(0, this.maxSnapshots - 1);
    if (!rootReport && this.snapshotCount >= nonRootSnapshotLimit) { this.limited = true; return false; }

    const json = JSON.stringify(report);
    if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) { this.limited = true; return false; }
    let payload = Buffer.from(json, 'utf8');
    try {
      const stat = await fs.lstat(reportPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { this.limited = true; return false; }
      const snapshot = { ...report };
      if (!Number.isFinite(snapshot.directoryModifiedMs)) snapshot.directoryModifiedMs = stat.mtimeMs;
      payload = Buffer.from(JSON.stringify(snapshot), 'utf8');
      if (payload.byteLength > MAX_JSON_BYTES) { this.limited = true; return false; }
      const compressed = await gzip(payload, { level: 1 });
      const nonRootBudget = Math.max(0, this.maxBytes - 4 * MiB);
      const budget = rootReport ? this.maxBytes : nonRootBudget;
      if (this.bytes + compressed.byteLength > budget) { this.limited = true; return false; }
      const name = `${crypto.createHash('sha256').update(pathKey(reportPath), 'utf8').digest('hex')}.json.gz`;
      await atomicWrite(path.join(this.directory, name), compressed);
      this.bytes += compressed.byteLength;
      this.snapshotCount++;
      return true;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) { this.limited = true; return false; }
      throw error;
    }
  }

  async finish(rootReport) {
    if (this.finished) throw new Error('Snapshot writer is already finished');
    const rootPath = rootReport?.path;
    if (typeof rootPath !== 'string' || pathKey(rootPath) !== this.rootKey) throw new Error('Final report must be for the scan root');
    const rootSaved = await this.write(rootReport, { isRoot: true });
    if (!rootSaved) throw new Error('Unable to save the root scan snapshot within cache limits');
    const manifest = {
      schema: 1,
      root: this.root,
      retainDepth: this.retainDepth,
      scannedAt: this.scannedAt,
      sourceIdentity: this.sourceIdentity,
      snapshotCount: this.snapshotCount,
      bytes: this.bytes,
      limited: this.limited,
      complete: true,
    };
    await atomicWrite(path.join(this.directory, 'manifest.json'), JSON.stringify(manifest));
    this.finished = true;
    return manifest;
  }
}

async function listCompleteBundles(baseDirectory) {
  let entries;
  try { entries = await fs.readdir(baseDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const bundles = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_NAME.test(entry.name)) continue;
    const directory = path.join(baseDirectory, entry.name);
    try {
      const dirStat = await fs.lstat(directory);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
      const bytes = await boundedRead(path.join(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
      if (!bytes) continue;
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!validManifest(manifest)) continue;
      bundles.push({ id: entry.name, directory, manifest });
    } catch (error) {
      if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) continue;
      throw error;
    }
  }
  return bundles;
}

async function assertSafeBase(baseDirectory) {
  await fs.mkdir(baseDirectory, { recursive: true });
  const stat = await fs.lstat(baseDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cache base must be a real directory');
}

async function removeTree(directory, baseDirectory) {
  const base = path.resolve(baseDirectory);
  const target = path.resolve(directory);
  if (path.dirname(target) !== base || !UUID_NAME.test(path.basename(target))) throw new Error('Refusing to remove a non-bundle cache path');
  const baseStat = await fs.lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('Cache base must be a real directory');
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) { await fs.unlink(target); return; }
  if (!stat.isDirectory()) { await fs.unlink(target); return; }
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    const childStat = await fs.lstat(child);
    if (childStat.isSymbolicLink() || !childStat.isDirectory()) await fs.unlink(child);
    else await removeDirectoryContents(child);
  }
  await fs.rmdir(target);
}

async function removeDirectoryContents(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink() || !stat.isDirectory()) await fs.unlink(child);
    else await removeDirectoryContents(child);
  }
  await fs.rmdir(directory);
}

class ScanCache {
  constructor(baseDirectory, { maxBytes = 256 * MiB, maxBundles = 12 } = {}) {
    this.baseDirectory = path.resolve(baseDirectory);
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.maxBundles = Math.max(1, Math.floor(Number(maxBundles) || 1));
  }

  async create(root, { retainDepth = 4 } = {}) {
    if (typeof root !== 'string') throw new TypeError('Cache bundle requires a root path');
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Cache root must be a real directory');
    await assertSafeBase(this.baseDirectory);
    const id = crypto.randomUUID();
    const directory = path.join(this.baseDirectory, id);
    await fs.mkdir(directory, { recursive: false });
    return { id, directory };
  }

  async lookup(requestedPath) {
    const requestedKey = pathKey(requestedPath);
    let current;
    try {
      const stat = await fs.lstat(requestedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      current = stat;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
      throw error;
    }
    const bundles = (await listCompleteBundles(this.baseDirectory)).sort((a, b) => Date.parse(b.manifest.scannedAt) - Date.parse(a.manifest.scannedAt));
    for (const bundle of bundles) {
      const manifest = bundle.manifest;
      if (!containsPath(manifest.root, requestedPath)) continue;
      let rootStat;
      try { rootStat = await fs.lstat(manifest.root); }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !identityMatches(manifest.sourceIdentity, sourceIdentity(rootStat))) continue;
      const fileName = `${crypto.createHash('sha256').update(requestedKey, 'utf8').digest('hex')}.json.gz`;
      const compressed = await boundedRead(path.join(bundle.directory, fileName), MAX_JSON_BYTES);
      if (!compressed) continue;
      let decoded;
      try {
        decoded = await gunzip(compressed, { maxOutputLength: MAX_JSON_BYTES });
        const report = JSON.parse(decoded.toString('utf8'));
        if (!report || typeof report.path !== 'string' || pathKey(report.path) !== requestedKey) continue;
        report.snapshot = {
          root: manifest.root,
          scannedAt: manifest.scannedAt,
          retainDepth: manifest.retainDepth,
          limited: manifest.limited,
          bundleId: bundle.id,
          stale: Number.isFinite(report.directoryModifiedMs) && report.directoryModifiedMs !== current.mtimeMs,
        };
        return report;
      } catch (error) {
        if (error instanceof SyntaxError || error.code === 'ERR_BUFFER_TOO_LARGE' || error.code === 'Z_BUF_ERROR' || error.code === 'Z_DATA_ERROR') continue;
        throw error;
      }
    }
    return null;
  }

  async info() {
    const bundles = await listCompleteBundles(this.baseDirectory);
    return {
      directory: this.baseDirectory,
      bundles: bundles.length,
      snapshots: bundles.reduce((sum, item) => sum + item.manifest.snapshotCount, 0),
      bytes: bundles.reduce((sum, item) => sum + item.manifest.bytes, 0),
    };
  }

  async recent() {
    const bundles = (await listCompleteBundles(this.baseDirectory)).sort((a, b) => Date.parse(b.manifest.scannedAt) - Date.parse(a.manifest.scannedAt));
    const roots = new Set();
    return bundles.filter(bundle => { const key = pathKey(bundle.manifest.root); if (roots.has(key)) return false; roots.add(key); return true; }).map(bundle => ({ root: bundle.manifest.root, scannedAt: bundle.manifest.scannedAt, retainDepth: bundle.manifest.retainDepth, snapshots: bundle.manifest.snapshotCount, bytes: bundle.manifest.bytes, limited: bundle.manifest.limited }));
  }

  async complete(directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== this.baseDirectory || !UUID_NAME.test(path.basename(target))) throw new Error('Unknown cache bundle directory');
    const bytes = await boundedRead(path.join(target, 'manifest.json'), MAX_MANIFEST_BYTES);
    if (!bytes) throw new Error('Cache bundle has no final manifest');
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Cache bundle manifest is invalid'); }
    if (!validManifest(manifest)) throw new Error('Cache bundle is incomplete or invalid');
    const bundles = (await listCompleteBundles(this.baseDirectory)).sort((a, b) => Date.parse(b.manifest.scannedAt) - Date.parse(a.manifest.scannedAt));
    let totalBytes = bundles.reduce((sum, item) => sum + item.manifest.bytes, 0);
    let totalBundles = bundles.length;
    const targetBundle = bundles.find(item => item.directory === target);
    if (!targetBundle) throw new Error('Completed bundle is not in the cache');
    for (const bundle of [...bundles].reverse()) {
      if (totalBytes <= this.maxBytes && totalBundles <= this.maxBundles) break;
      await removeTree(bundle.directory, this.baseDirectory);
      totalBytes -= bundle.manifest.bytes;
      totalBundles--;
    }
    return manifest;
  }

  async discard(directory) {
    await removeTree(directory, this.baseDirectory);
  }

  async invalidate(changedPath) {
    const key = path.resolve(changedPath);
    let removed = 0;
    for (const bundle of await listCompleteBundles(this.baseDirectory)) {
      if (containsPath(bundle.manifest.root, key) || containsPath(key, bundle.manifest.root)) {
        await removeTree(bundle.directory, this.baseDirectory);
        removed++;
      }
    }
    return removed;
  }

  async clear() {
    let removed = 0;
    let entries;
    try { entries = await fs.readdir(this.baseDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    for (const entry of entries) {
      if (!UUID_NAME.test(entry.name)) continue;
      const directory = path.join(this.baseDirectory, entry.name);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      await removeTree(directory, this.baseDirectory);
      removed++;
    }
    return removed;
  }

  async recover() {
    let entries;
    try { entries = await fs.readdir(this.baseDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_NAME.test(entry.name)) continue;
      const directory = path.join(this.baseDirectory, entry.name);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const bytes = await boundedRead(path.join(directory, 'manifest.json'), MAX_MANIFEST_BYTES);
      let complete = false;
      if (bytes) {
        try { complete = validManifest(JSON.parse(bytes.toString('utf8'))); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (!complete) {
        await removeTree(directory, this.baseDirectory);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = { SnapshotWriter, ScanCache, pathKey, containsPath };
