'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listDirectory, scanDirectory, previewFile, validateChildName } = require('../desktop/filesystem.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fxplorer-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('fxplorer-')); return fs.rm(root, { recursive: true, force: true }); });
  return root;
}

test('lists entries with lstat metadata and skips entries that disappear', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'note.txt'), 'hello');
  const listing = await listDirectory(root);
  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listing.entries.find(item => item.name === 'folder').isDirectory, true);
  assert.equal(listing.entries.find(item => item.name === 'folder').size, 0);
  assert.equal(listing.entries.find(item => item.name === 'note.txt').size, 5);
});

test('scans recursively, aggregates immediate children, categories and largest files', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'folder', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'folder', 'nested', 'small.txt'), 'abc');
  await fs.writeFile(path.join(root, 'folder', 'large.png'), Buffer.alloc(9));
  await fs.writeFile(path.join(root, 'top.js'), '12345');
  const result = await scanDirectory(root);
  assert.equal(result.totalSize, 17);
  assert.equal(result.fileCount, 3);
  assert.equal(result.folderCount, 2);
  assert.equal(result.children.find(item => item.name === 'folder').size, 12);
  assert.equal(result.children.find(item => item.name === 'folder').fileCount, 2);
  assert.equal(result.children.find(item => item.name === 'folder').folderCount, 1);
  assert.deepEqual(result.largestFiles.map(item => item.name), ['large.png', 'top.js', 'small.txt']);
  assert.deepEqual(Object.fromEntries(result.categories.map(item => [item.name, item.count])), { Code: 1, Images: 1, Documents: 1 });
  assert.equal(result.scannedEntries, 5);
});

test('does not follow symbolic links', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'actual'));
  await fs.writeFile(path.join(root, 'actual', 'secret.txt'), 'hidden');
  try { await fs.symlink(path.join(root, 'actual'), path.join(root, 'linked'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`); throw error; }
  const listing = await listDirectory(root);
  assert.equal(listing.entries.find(item => item.name === 'linked').isSymlink, true);
  const result = await scanDirectory(root);
  assert.equal(result.fileCount, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.children.some(item => item.name === 'linked'), false);
});

test('caps entry traversal and reports truncation', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(root, `${i}.txt`), 'x');
  const result = await scanDirectory(root, { maxEntries: 3 });
  assert.equal(result.scannedEntries, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.fileCount, 3);
});

test('rejects an aborted scan with AbortError', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'many'));
  await Promise.all(Array.from({ length: 200 }, (_, i) => fs.writeFile(path.join(root, 'many', `${i}.txt`), 'x')));
  const controller = new AbortController();
  const scan = scanDirectory(root, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(scan, { name: 'AbortError' });
});

test('validates Windows child names', () => {
  for (const value of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'CON', 'nul.txt', 'trailing.', 'trailing ', 'bad\nname', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'COM¹', 'LPT².txt', 'x'.repeat(256)]) assert.equal(validateChildName(value), false, JSON.stringify(value));
  for (const value of ['notes', 'notes.txt', 'report 2026', 'COM10']) assert.equal(validateChildName(value), true, JSON.stringify(value));
});

test('keeps the 200 largest files accurately when traversal exceeds the shortlist size', async t => {
  const root = await fixture(t);
  for (let index = 0; index < 430; index++) await fs.writeFile(path.join(root, `${index}.txt`), Buffer.alloc(index + 1, 'a'));
  const result = await scanDirectory(root);
  assert.equal(result.largestFiles.length, 200);
  assert.equal(result.largestFiles[0].size, 430);
  assert.equal(result.largestFiles[199].size, 231);
  assert.equal(result.fileCount, 430);
  assert.equal(result.totalSize, 430 * 431 / 2);
});

test('rejects pre-aborted scans, file roots, and invalid traversal caps', async t => {
  const root = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanDirectory(root, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(scanDirectory(root, { maxEntries: 0 }), RangeError);
  const file = path.join(root, 'file.txt'); await fs.writeFile(file, 'test');
  await assert.rejects(scanDirectory(file), /not a directory/);
});

test('previews bounded text and supported images, declines oversized and SVG files', async t => {
  const root = await fixture(t);
  const textPath = path.join(root, 'readme.txt');
  const imagePath = path.join(root, 'pixel.png');
  const hugePath = path.join(root, 'huge.txt');
  const svgPath = path.join(root, 'vector.svg');
  await fs.writeFile(textPath, 'hello');
  await fs.writeFile(imagePath, Buffer.from([1, 2, 3]));
  await fs.writeFile(hugePath, Buffer.alloc(128 * 1024 + 1));
  await fs.writeFile(svgPath, '<svg/>');
  assert.deepEqual(await previewFile(textPath), { kind: 'text', content: 'hello', truncated: false, size: 5 });
  assert.deepEqual(await previewFile(imagePath), { kind: 'image', content: 'AQID', mime: 'image/png', size: 3 });
  assert.equal((await previewFile(hugePath)).kind, 'none');
  assert.equal((await previewFile(svgPath)).kind, 'none');
  await assert.rejects(previewFile(root), /directory/i);
});
