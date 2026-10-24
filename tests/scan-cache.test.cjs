'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { SnapshotWriter, ScanCache, pathKey, containsPath } = require('../desktop/scan-cache.cjs');

const gunzip = promisify(zlib.gunzip);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(__dirname, '.scan-cache-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(__dirname));
    assert.ok(path.basename(directory).startsWith('.scan-cache-test-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function identityFor(root) {
  const stat = await fs.lstat(root);
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

async function writeBundle(cache, root, report = {}, options = {}) {
  const { id, directory } = await cache.create(root);
  const writer = new SnapshotWriter(directory, {
    root,
    scannedAt: options.scannedAt || new Date().toISOString(),
    sourceIdentity: options.sourceIdentity === undefined ? await identityFor(root) : options.sourceIdentity,
    maxBytes: options.maxBytes,
    maxSnapshots: options.maxSnapshots,
    retainDepth: options.retainDepth ?? 4,
  });
  const rootReport = { path: root, totalSize: 0, children: [], ...report };
  for (const child of options.children || []) await writer.write(child);
  const manifest = await writer.finish(rootReport);
  await cache.complete(directory);
  return { id, directory, manifest };
}

test('path keys normalize and containment respects path component boundaries', async t => {
  const root = await fixture(t);
  const child = path.join(root, 'one', '..', 'child');
  assert.equal(pathKey(child), pathKey(path.join(root, 'child')));
  assert.equal(containsPath(root, root), true);
  assert.equal(containsPath(root, path.join(root, 'child')), true);
  assert.equal(containsPath(root, `${root}-other`), false);
});

test('writes compressed per-folder snapshots, restores with a new cache instance, and marks stale directories', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  const child = path.join(root, 'child');
  await fs.mkdir(child, { recursive: true });
  const scannedMtime = (await fs.stat(child)).mtimeMs;
  const cache = new ScanCache(path.join(base, 'cache'));
  const bundle = await writeBundle(cache, root, { totalSize: 3 }, { children: [{ path: child, totalSize: 3, directoryModifiedMs: scannedMtime, children: [] }] });
  const restored = new ScanCache(path.join(base, 'cache'));
  const report = await restored.lookup(child);
  assert.equal(report.totalSize, 3);
  assert.equal(report.directoryModifiedMs, scannedMtime);
  assert.deepEqual(report.snapshot, { root, scannedAt: bundle.manifest.scannedAt, retainDepth: 4, limited: false, bundleId: bundle.id, stale: false });
  const old = (await fs.stat(child)).mtime;
  await fs.utimes(child, old, new Date(old.getTime() + 4000));
  assert.equal((await restored.lookup(child)).snapshot.stale, true);
  assert.deepEqual(await restored.info(), { directory: path.join(base, 'cache'), bundles: 1, snapshots: 2, bytes: bundle.manifest.bytes });
});

test('does not publish a complete manifest if the root snapshot cannot fit', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  const cache = new ScanCache(path.join(base, 'cache'));
  const { directory } = await cache.create(root);
  const writer = new SnapshotWriter(directory, { root, maxBytes: 1 });
  await assert.rejects(writer.finish({ path: root, children: [] }), /root scan snapshot/);
  await assert.rejects(fs.access(path.join(directory, 'manifest.json')));
});

test('retains only configured depth and reserves snapshot count and byte budget for the root', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  const child = path.join(root, 'child');
  const deep = path.join(child, 'deep');
  await fs.mkdir(deep, { recursive: true });
  const cache = new ScanCache(path.join(base, 'cache'));
  const bundle = await writeBundle(cache, root, {}, {
    retainDepth: 1, maxSnapshots: 2, maxBytes: 8 * 1024 * 1024,
    children: [{ path: child, children: [] }, { path: deep, children: [] }],
  });
  assert.equal(bundle.manifest.snapshotCount, 2);
  assert.equal(bundle.manifest.limited, true);
  assert.ok(await cache.lookup(root));
  assert.ok(await cache.lookup(child));
  assert.equal(await cache.lookup(deep), null);

  const tight = await new ScanCache(path.join(base, 'tight-cache')).create(root);
  const writer = new SnapshotWriter(tight.directory, { root, maxBytes: 1024 * 1024, maxSnapshots: 10, sourceIdentity: await identityFor(root) });
  assert.equal(await writer.write({ path: child, children: [] }), false);
  const manifest = await writer.finish({ path: root, children: [] });
  assert.equal(manifest.snapshotCount, 1);
  assert.equal(manifest.limited, true);
});

test('ignores corrupt manifests and compressed snapshots without throwing', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  const cache = new ScanCache(path.join(base, 'cache'));
  const bundle = await writeBundle(cache, root);
  const snapshotName = `${crypto.createHash('sha256').update(pathKey(root)).digest('hex')}.json.gz`;
  await fs.writeFile(path.join(bundle.directory, snapshotName), Buffer.from('not gzip'));
  assert.equal(await cache.lookup(root), null);
  await fs.writeFile(path.join(bundle.directory, 'manifest.json'), '{ broken');
  assert.equal(await cache.lookup(root), null);
});

test('ignores a report whose embedded path does not match the requested hashed snapshot', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  const sibling = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(sibling);
  const cache = new ScanCache(path.join(base, 'cache'));
  const bundle = await writeBundle(cache, root);
  const name = `${crypto.createHash('sha256').update(pathKey(root)).digest('hex')}.json.gz`;
  await fs.writeFile(path.join(bundle.directory, name), await promisify(zlib.gzip)(JSON.stringify({ path: sibling }), { level: 1 }));
  assert.equal(await cache.lookup(root), null);
});

test('refuses to write a report outside the selected root', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'source');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const cache = new ScanCache(path.join(base, 'cache'));
  const bundle = await cache.create(root);
  const writer = new SnapshotWriter(bundle.directory, { root });
  await assert.rejects(writer.write({ path: outside }), /outside the scan root/);
});

test('rejects a replaced root identity and does not confuse similarly prefixed roots', async t => {
  const base = await fixture(t);
  const root = path.join(base, 'root');
  const sibling = path.join(base, 'root-extra');
  await fs.mkdir(root);
  await fs.mkdir(sibling);
  const cache = new ScanCache(path.join(base, 'cache'));
  const staleIdentity = await identityFor(root);
  staleIdentity.ino += 1;
  await writeBundle(cache, root, {}, { sourceIdentity: staleIdentity });
  assert.equal(await cache.lookup(root), null);
  assert.equal(await cache.invalidate(sibling), 0);
  assert.equal((await cache.info()).bundles, 1);
});

test('invalidates ancestor and descendant roots, case-insensitively on Windows', async t => {
  const base = await fixture(t);
  const one = path.join(base, 'One');
  const nested = path.join(one, 'Nested');
  const sibling = path.join(base, 'One-more');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(sibling);
  const cache = new ScanCache(path.join(base, 'cache'));
  await writeBundle(cache, one);
  await writeBundle(cache, nested);
  await writeBundle(cache, sibling);
  const changed = process.platform === 'win32'
    ? path.join(base.toLowerCase(), 'one', 'nested', 'changed')
    : path.join(nested, 'changed');
  assert.equal(await cache.invalidate(changed), 2);
  assert.equal((await cache.info()).bundles, 1);
});

test('prunes oldest completed bundles to count and byte caps', async t => {
  const base = await fixture(t);
  const cache = new ScanCache(path.join(base, 'cache'), { maxBundles: 2, maxBytes: 4 * 1024 * 1024 });
  const roots = [];
  for (let index = 0; index < 3; index++) {
    const root = path.join(base, `root-${index}`);
    await fs.mkdir(root);
    roots.push(root);
    await writeBundle(cache, root, {}, { scannedAt: new Date(Date.now() + index * 1000).toISOString() });
  }
  assert.deepEqual((await cache.info()).bundles, 2);
  assert.equal(await cache.lookup(roots[0]), null);
  assert.ok(await cache.lookup(roots[2]));
});

test('clear removes only UUID cache bundles and leaves unknown user files untouched', async t => {
  const base = await fixture(t);
  const cacheDir = path.join(base, 'cache');
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, 'notes.txt'), 'keep');
  await fs.mkdir(path.join(cacheDir, 'ordinary-folder'));
  const cache = new ScanCache(cacheDir);
  await writeBundle(cache, root);
  assert.equal(await cache.clear(), 1);
  assert.equal(await fs.readFile(path.join(cacheDir, 'notes.txt'), 'utf8'), 'keep');
  assert.equal((await fs.readdir(cacheDir)).sort().join(','), 'notes.txt,ordinary-folder');
});

test('startup recovery removes orphaned and invalid UUID bundles, preserving complete and unrelated entries', async t => {
  const base = await fixture(t);
  const cacheDir = path.join(base, 'cache');
  const root = path.join(base, 'source');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'keep');
  const cache = new ScanCache(cacheDir);

  const orphan = await cache.create(root);
  const invalidDir = path.join(cacheDir, crypto.randomUUID());
  await fs.mkdir(invalidDir, { recursive: true });
  await fs.writeFile(path.join(invalidDir, 'manifest.json'), '{ incomplete');
  let nestedLink;
  try {
    nestedLink = path.join(invalidDir, 'external-link');
    await fs.symlink(outside, nestedLink, 'junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    nestedLink = undefined;
  }

  const complete = await writeBundle(cache, root);
  const unrelatedFile = path.join(cacheDir, 'keep.txt');
  const unrelatedDirectory = path.join(cacheDir, 'user-folder');
  await fs.writeFile(unrelatedFile, 'keep');
  await fs.mkdir(unrelatedDirectory);
  const outsideLink = path.join(cacheDir, crypto.randomUUID());
  try { await fs.symlink(outside, outsideLink, 'junction'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }

  assert.equal(await cache.recover(), 2);
  await assert.rejects(fs.access(orphan.directory));
  await assert.rejects(fs.access(invalidDir));
  if (nestedLink) assert.ok(await fs.access(nestedLink).then(() => false, error => error.code === 'ENOENT'));
  assert.ok(await cache.lookup(root), 'valid complete bundle remains usable');
  assert.equal(await fs.readFile(unrelatedFile, 'utf8'), 'keep');
  assert.ok((await fs.stat(unrelatedDirectory)).isDirectory());
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
  await fs.access(complete.directory);
  if (await fs.lstat(outsideLink).then(() => true, () => false)) assert.ok((await fs.lstat(outsideLink)).isSymbolicLink());
});

test('remove operations reject paths outside direct UUID bundle children', async t => {
  const base = await fixture(t);
  const cache = new ScanCache(path.join(base, 'cache'));
  await fs.mkdir(cache.baseDirectory);
  await assert.rejects(cache.discard(path.join(base, 'not-a-bundle')), /non-bundle/);
});
