'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanDirectory } = require('../desktop/filesystem.cjs');
const { ScanCache } = require('../desktop/scan-cache.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.hierarchy-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.hierarchy-test-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function put(root, relative, size) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(size, 'x'));
  return file;
}

function categoryMap(report) {
  return Object.fromEntries(report.categories.map(item => [item.name, { size: item.size, count: item.count }]));
}

test('streams accurate aggregate reports and caches the root through four folder hops', async t => {
  const workspace = await fixture(t);
  const root = path.join(workspace, 'tree');
  const alpha = path.join(root, 'alpha');
  const beta = path.join(alpha, 'beta');
  const gamma = path.join(beta, 'gamma');
  const delta = path.join(gamma, 'delta');
  const epsilon = path.join(delta, 'epsilon');
  await fs.mkdir(root, { recursive: true });
  await put(root, 'root.txt', 2);
  await put(alpha, 'alpha.pdf', 3);
  await put(alpha, 'side.png', 17);
  await put(beta, 'beta.png', 5);
  await put(gamma, 'gamma.js', 7);
  await put(delta, 'delta.mp3', 11);
  await put(epsilon, 'epsilon.md', 13);

  const cache = new ScanCache(path.join(workspace, 'cache'));
  const session = await cache.create(root, { retainDepth: 4 });
  const report = await scanDirectory(root, { cacheDirectory: session.directory, retainDepth: 4 });
  await cache.complete(session.directory);
  assert.equal(report.totalSize, 58);
  assert.equal(report.fileCount, 7);
  assert.equal(report.folderCount, 5);
  assert.equal(report.truncated, false);
  assert.equal(report.cacheInfo.complete, true);

  const restoredCache = new ScanCache(path.join(workspace, 'cache'));
  const expected = new Map([
    [root, { size: 58, files: 7, folders: 5, depth: 4, categories: { Documents: { size: 18, count: 3 }, Images: { size: 22, count: 2 }, Code: { size: 7, count: 1 }, Audio: { size: 11, count: 1 } } }],
    [alpha, { size: 56, files: 6, folders: 4, depth: 3, categories: { Documents: { size: 16, count: 2 }, Images: { size: 22, count: 2 }, Code: { size: 7, count: 1 }, Audio: { size: 11, count: 1 } } }],
    [beta, { size: 36, files: 4, folders: 3, depth: 2, categories: { Documents: { size: 13, count: 1 }, Images: { size: 5, count: 1 }, Code: { size: 7, count: 1 }, Audio: { size: 11, count: 1 } } }],
    [gamma, { size: 31, files: 3, folders: 2, depth: 1, categories: { Documents: { size: 13, count: 1 }, Code: { size: 7, count: 1 }, Audio: { size: 11, count: 1 } } }],
    [delta, { size: 24, files: 2, folders: 1, depth: 0, categories: { Documents: { size: 13, count: 1 }, Audio: { size: 11, count: 1 } } }],
  ]);
  for (const [folder, values] of expected) {
    const saved = await restoredCache.lookup(folder);
    assert.ok(saved, `expected a snapshot for ${folder}`);
    assert.equal(saved.path, folder);
    assert.equal(saved.totalSize, values.size);
    assert.equal(saved.fileCount, values.files);
    assert.equal(saved.folderCount, values.folders);
    assert.equal(saved.retainedDepth, values.depth);
    assert.deepEqual(categoryMap(saved), values.categories);
    assert.ok(saved.largestFiles.length > 0);
  }
  const deepestSaved = await restoredCache.lookup(delta);
  assert.deepEqual(deepestSaved.largestFiles.map(file => file.size), [13, 11]);
  assert.equal(await restoredCache.lookup(epsilon), null, 'fifth subfolder hop is beyond retainDepth');
  assert.equal((await restoredCache.lookup(root)).totalSize, 58, 'uncached fifth-level files still contribute to parent totals');
});

test('a completed child snapshot stays accurate when the enclosing scan reaches its entry cap', async t => {
  const workspace = await fixture(t);
  const root = path.join(workspace, 'partial-tree');
  await fs.mkdir(root);
  const folders = ['a-small', 'b-small', 'c-small', 'z-large'];
  for (const name of folders) {
    const folder = path.join(root, name);
    await fs.mkdir(folder);
    await put(folder, 'one.txt', 6);
  }
  const order = await fs.readdir(root);
  const largeName = order.at(-1);
  const largeFolder = path.join(root, largeName);
  for (let index = 0; index < 40; index++) await put(largeFolder, `part-${index}.txt`, index + 1);
  const smallNames = order.filter(name => name !== largeName);
  const cachedFolder = path.join(root, smallNames[0]);
  const smallEntries = smallNames.length;
  const maxEntries = folders.length + smallEntries + 3;

  const cache = new ScanCache(path.join(workspace, 'cache'));
  const session = await cache.create(root);
  const report = await scanDirectory(root, { cacheDirectory: session.directory, retainDepth: 4, maxEntries });
  await cache.complete(session.directory);
  assert.equal(report.truncated, true, 'entry cap marks the enclosing report partial');
  assert.equal(report.scannedEntries, maxEntries);
  const independentlyRestored = await new ScanCache(path.join(workspace, 'cache')).lookup(cachedFolder);
  assert.ok(independentlyRestored);
  assert.equal(independentlyRestored.totalSize, 6);
  assert.equal(independentlyRestored.fileCount, 1);
  assert.equal(independentlyRestored.truncated, false);
  assert.deepEqual(categoryMap(independentlyRestored), { Documents: { size: 6, count: 1 } });
  assert.equal(independentlyRestored.largestFiles[0].name, 'one.txt');
});

test('final progress contains real totals, categories, children, and largest files for a 1000-file scan', async t => {
  const workspace = await fixture(t);
  const root = path.join(workspace, 'many-files');
  await fs.mkdir(root);
  let expectedSize = 0;
  for (let index = 0; index < 1000; index++) {
    const size = index % 37 + 1;
    expectedSize += size;
    await fs.writeFile(path.join(root, `${String(index).padStart(4, '0')}.txt`), Buffer.alloc(size, index % 255));
  }
  const progress = [];
  const report = await scanDirectory(root, { onProgress: item => progress.push(item) });
  const final = progress.at(-1);
  assert.ok(final?.partial);
  assert.equal(typeof final.partial.inProgress, 'boolean');
  assert.equal(final.partial.path, root);
  assert.equal(final.partial.totalSize, report.totalSize);
  assert.equal(final.partial.fileCount, report.fileCount);
  assert.equal(final.partial.totalSize, expectedSize);
  assert.equal(final.partial.fileCount, 1000);
  assert.deepEqual(final.partial.categories, [{ name: 'Documents', size: expectedSize, count: 1000 }]);
  assert.ok(final.partial.children.length > 0);
  assert.ok(final.partial.children.every(item => item.size > 0 && item.path.startsWith(`${root}${path.sep}`)));
  assert.equal(final.partial.largestFiles.length, 50);
  assert.equal(final.partial.largestFiles[0].size, 37);
  assert.ok(final.partial.largestFiles.every(file => file.size <= 37 && file.path.startsWith(`${root}${path.sep}`)));
  const represented = final.partial.children.reduce((sum, item) => sum + item.size, 0);
  assert.equal(final.partial.additionalChildren.size, Math.max(0, report.totalSize - represented));
});

test('aborting a worker before scan completion leaves no publishable manifest', async t => {
  const workspace = await fixture(t);
  const root = path.join(workspace, 'cancel-me');
  await fs.mkdir(root);
  for (let index = 0; index < 50; index++) await put(root, `folder-${index}/file.txt`, 32);
  const cache = new ScanCache(path.join(workspace, 'cache'));
  const session = await cache.create(root);
  const controller = new AbortController();
  const scan = scanDirectory(root, { cacheDirectory: session.directory, signal: controller.signal });
  controller.abort();
  await assert.rejects(scan, { name: 'AbortError' });
  await assert.rejects(fs.access(path.join(session.directory, 'manifest.json')));
  assert.equal(await cache.lookup(root), null);
  await cache.discard(session.directory);
  await assert.rejects(fs.access(session.directory));
});
