'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const groups = {
  Images: /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i,
  Videos: /\.(mp4|m4v|mov|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i,
  Audio: /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|aiff)$/i,
  Documents: /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|pptx?|csv)$/i,
  Archives: /\.(zip|rar|7z|tar|gz|bz2|xz|cab|iso)$/i,
  Code: /\.(js|cjs|mjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rs|php|html|css|json|xml|yml|yaml|sh|ps1)$/i,
};
const matchers = Object.entries(groups);
const bySize = (a, b) => b.size - a.size || a.name.localeCompare(b.name);
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
function metadata(filename, stat) {
  return { name: path.basename(filename), path: filename, isDirectory: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, fileCount: stat.isFile() ? 1 : 0, folderCount: 0, modified: Number.isFinite(stat.mtimeMs) ? stat.mtime.toISOString() : null, extension: path.extname(filename).toLowerCase() };
}

module.exports = async function scan(root, { maxEntries = 250000, retainDepth = 4, cacheDirectory, onProgress = () => {} } = {}) {
  const started = Date.now();
  root = path.resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Scan path is not a directory');
  retainDepth = Number.isInteger(retainDepth) ? Math.max(0, Math.min(6, retainDepth)) : 4;
  const scannedAt = new Date().toISOString();
  const totals = { totalSize: 0, fileCount: 0, folderCount: 0, skipped: 0, scannedEntries: 0, truncated: false };
  const active = [];
  let rootReport;
  let rootChild;
  let lastProgress = 0;
  let writer;
  let cacheError;
  if (cacheDirectory) {
    const { SnapshotWriter } = require('./scan-cache.cjs');
    writer = new SnapshotWriter(cacheDirectory, { root, retainDepth, scannedAt, sourceIdentity: identity(rootStat) });
  }
  function progress(currentPath, force = false) {
    const now = Date.now();
    if (!force && now - lastProgress < 750) return;
    lastProgress = now;
    const candidates = [...(rootReport?.children || [])];
    if (rootChild) candidates.push({ ...rootChild });
    const children = candidates.filter(entry => entry.size > 0).sort(bySize).slice(0, 48).map(entry => ({ ...entry }));
    const represented = children.reduce((sum, entry) => sum + entry.size, 0);
    onProgress({ ...totals, currentPath, partial: {
      path: root, ...totals, inProgress: true, durationMs: now - started, children,
      categories: rootReport ? [...rootReport._categories.values()].map(entry => ({ ...entry })) : [],
      largestFiles: rootReport ? [...rootReport._largest].sort(bySize).slice(0, 50) : [],
      additionalChildren: { count: Math.max(0, candidates.filter(entry => entry.size > 0).length - children.length) + (rootReport?.additionalChildren.count || 0), size: Math.max(0, totals.totalSize - represented) },
    } });
  }
  const rememberFile = file => {
    totals.totalSize += file.size; totals.fileCount++;
    if (rootChild) { rootChild.size += file.size; rootChild.fileCount++; }
    const categoryName = matchers.find(([, regex]) => regex.test(file.extension))?.[0] || 'Other';
    for (const report of active) {
      report._liveSize += file.size; report._liveFiles++;
      const category = report._categories.get(categoryName) || { name: categoryName, size: 0, count: 0 };
      category.size += file.size; category.count++; report._categories.set(categoryName, category);
      report._largest.push(file);
      if (report._largest.length > 400) { report._largest.sort(bySize); report._largest.length = 200; }
    }
  };
  const keepChild = (report, child) => {
    if (!report) return;
    const estimate = (child.path.length + child.name.length) * 2 + 240;
    if (report.children.length < 5000 && report._childBytes + estimate < 2 * 1024 * 1024) { report.children.push(child); report._childBytes += estimate; }
    else { report.additionalChildren.count++; report.additionalChildren.size += child.size; }
  };
  async function walk(folder, depth, folderStat) {
    const began = Date.now();
    const summary = { size: 0, fileCount: 0, folderCount: 0, skipped: 0, truncated: false };
    const report = depth <= retainDepth ? { path: folder, children: [], additionalChildren: { count: 0, size: 0 }, _categories: new Map(), _largest: [], _childBytes: 0, _liveSize: 0, _liveFiles: 0, _liveFolders: 0, directoryModifiedMs: folderStat.mtimeMs, retainedDepth: retainDepth - depth, scannedAt } : null;
    if (report) { active.push(report); if (depth === 0) rootReport = report; }
    try {
      const directory = await fs.opendir(folder, { bufferSize: 64 });
      for await (const dirent of directory) {
        progress(folder);
        if (totals.scannedEntries >= maxEntries) { totals.truncated = true; summary.truncated = true; break; }
        const target = path.join(folder, dirent.name);
        totals.scannedEntries++;
        let stat;
        try { stat = await fs.lstat(target); }
        catch { totals.skipped++; summary.skipped++; continue; }
        if (stat.isSymbolicLink()) { totals.skipped++; summary.skipped++; continue; }
        if (stat.isFile()) {
          const file = metadata(target, stat);
          rememberFile(file); summary.size += file.size; summary.fileCount++;
          keepChild(report, file);
        } else if (stat.isDirectory()) {
          totals.folderCount++;
          for (const activeReport of active) activeReport._liveFolders++;
          if (rootChild) rootChild.folderCount++;
          if (depth >= 128) { totals.skipped++; summary.skipped++; summary.folderCount++; summary.truncated = true; continue; }
          if (depth === 0) rootChild = metadata(target, stat);
          const childStats = await walk(target, depth + 1, stat);
          summary.size += childStats.size; summary.fileCount += childStats.fileCount;
          summary.folderCount += childStats.folderCount + 1; summary.skipped += childStats.skipped;
          summary.truncated ||= childStats.truncated;
          keepChild(report, { ...metadata(target, stat), size: childStats.size, fileCount: childStats.fileCount, folderCount: childStats.folderCount, skipped: childStats.skipped, truncated: childStats.truncated });
          if (depth === 0) rootChild = null;
          if (totals.truncated) { summary.truncated = true; break; }
        } else { totals.skipped++; summary.skipped++; }
      }
    } catch (error) {
      if (depth === 0) throw error;
      totals.skipped++; summary.skipped++;
    }
    if (report) {
      active.pop();
      report.totalSize = summary.size; report.fileCount = summary.fileCount; report.folderCount = summary.folderCount;
      report.skipped = summary.skipped; report.truncated = summary.truncated;
      report.durationMs = Date.now() - began;
      report.scannedEntries = depth === 0 ? totals.scannedEntries : summary.fileCount + summary.folderCount + summary.skipped;
      report.children.sort(bySize);
      report.categories = [...report._categories.values()].sort((a, b) => a.name.localeCompare(b.name));
      report.largestFiles = report._largest.sort(bySize).slice(0, 200);
      if (depth > 0) {
        delete report._categories; delete report._largest; delete report._childBytes; delete report._liveSize; delete report._liveFiles; delete report._liveFolders;
        if (writer && !cacheError) { try { await writer.write(report); } catch (error) { cacheError = error.code || error.message; } }
      }
    }
    return summary;
  }
  await walk(root, 0, rootStat);
  progress(root, true);
  delete rootReport._categories; delete rootReport._largest; delete rootReport._childBytes; delete rootReport._liveSize; delete rootReport._liveFiles; delete rootReport._liveFolders;
  if (writer && !cacheError) { try { rootReport.cacheInfo = await writer.finish(rootReport); } catch (error) { cacheError = error.code || error.message; } }
  if (cacheError) rootReport.cacheError = String(cacheError);
  rootReport.durationMs = Date.now() - started;
  return rootReport;
};
