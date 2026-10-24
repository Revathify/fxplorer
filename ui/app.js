'use strict';
const api = window.fxplorer;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const palette = ['#3276d2', '#268e98', '#bc752f', '#9a4ebc', '#c64b77', '#4c9144', '#6d62d0', '#a39632', '#2584ab', '#be5b53', '#359b80', '#8c67bf'];
const categoryColors = { Images: '#4bbbd1', Videos: '#a27ce4', Audio: '#ed9b50', Documents: '#54c4a7', Archives: '#e27798', Code: '#85bc56', Other: '#7c95b6' };
const state = { places: [], drives: [], tabs: [], activeTab: 0, entries: [], parent: null, selected: null, scan: null, scanning: false, view: 'browse', sort: 'name', direction: 1, query: '', showHidden: false, navigationId: 0, scanToken: 0, favorites: [], review: [], mapCollapsed: false, rowLimit: 1500, clipboard: false, cachedRoots: [] };
let toastTimer;
let dialogAction;
let previousScan = null;
function colorHash(value) { let hash = 0; for (const char of String(value).toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0; return palette[(hash >>> 0) % palette.length]; }
function itemColor(entry) { const i = itemIcon(entry); return entry.isDirectory ? colorHash(entry.path || entry.name) : ({ pictures: '#62cce3', videos: '#b493f4', music: '#ed9bc9', archive: '#efb259', code: '#7ed3a4', file: /\.(exe|msi|dll|sys|com|bat|cmd|ps1)$/i.test(entry.extension || '') ? '#e78b9c' : '#8ebcf3', link: '#bcadf1' })[i] || '#9fbbd8'; }
function snapshotTime(value) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function mergeMeasured(report) {
  if (!report) return;
  const measured = new Map(report.children.map(entry => [entry.path.toLowerCase(), entry]));
  state.entries = state.entries.map(entry => { const saved = measured.get(entry.path.toLowerCase()); return saved && entry.isDirectory ? { ...entry, size: saved.size, fileCount: saved.fileCount, folderCount: saved.folderCount } : entry; });
  if (state.selected) state.selected = entryByPath(state.selected.path) || null;
}

function readStorage(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback; } catch { return fallback; } }
state.favorites = readStorage('fxplorer-pins', []).filter(x => x && typeof x.path === 'string' && typeof x.name === 'string').slice(0, 30);
state.review = readStorage('fxplorer-review', []).filter(x => x && typeof x.path === 'string' && typeof x.name === 'string').slice(0, 500);
function saveLocal() { try { localStorage.setItem('fxplorer-pins', JSON.stringify(state.favorites)); localStorage.setItem('fxplorer-review', JSON.stringify(state.review)); } catch { toast('Your local preferences could not be saved.', true); } }
function currentTab() { return state.tabs.find(t => t.id === state.activeTab); }
function currentPath() { return currentTab()?.path || ''; }
function basename(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
function formatBytes(bytes, decimal = 1) { if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'; if (bytes === 0) return '0 B'; const index = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), 4); return `${(bytes / (1024 ** index)).toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : decimal })} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`; }
function number(n) { return (n || 0).toLocaleString(); }
function date(value) { return value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
function type(entry) { if (entry.isSymlink) return 'Link'; return entry.isDirectory ? 'Folder' : (entry.extension ? entry.extension.slice(1).toUpperCase() + ' file' : 'File'); }
function itemIcon(entry) { if (entry.isSymlink) return 'link'; if (entry.isDirectory) return 'folder'; const ext = (entry.extension || '').toLowerCase(); if (/^\.(png|jpg|jpeg|gif|webp|bmp|heic|svg|avif)$/.test(ext)) return 'pictures'; if (/^\.(zip|rar|7z|gz|tar|iso)$/.test(ext)) return 'archive'; if (/^\.(mp4|mkv|avi|mov|webm)$/.test(ext)) return 'videos'; if (/^\.(mp3|wav|flac|m4a|ogg)$/.test(ext)) return 'music'; if (/^\.(js|ts|tsx|jsx|json|py|rs|cs|cpp|html|css|cjs|yml)$/.test(ext)) return 'code'; return 'file'; }
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); $('toast').className = `toast visible${error ? ' error' : ''}`; toastTimer = setTimeout(() => $('toast').classList.remove('visible'), error ? 6500 : 3000); }
async function attempt(action) { try { return await action(); } catch (error) { toast(error.message || error, true); return undefined; } }
function status(message, detail) { $('status').innerHTML = `<span class="online-dot"></span>${esc(message)}`; if (detail !== undefined) $('status-detail').textContent = detail; }
function reviewed(p) { return state.review.some(e => e.path === p); }
function isHidden(e) { return e.name.startsWith('.') || e.name.startsWith('$'); }
function effectiveEntries() {
  let entries = state.view === 'review' ? state.review : state.view === 'large' ? state.scan?.largestFiles || [] : state.entries;
  entries = entries.filter(e => (state.showHidden || !isHidden(e)) && `${e.name} ${state.view === 'browse' ? '' : e.path}`.toLowerCase().includes(state.query.toLowerCase()));
  return [...entries].sort((a, b) => {
    if (state.view === 'browse' && state.sort === 'name' && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let result;
    if (state.sort === 'size') result = (a.size ?? -1) - (b.size ?? -1);
    else if (state.sort === 'modified') result = (a.modified || '').localeCompare(b.modified || '');
    else if (state.sort === 'extension') result = type(a).localeCompare(type(b));
    else result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return result * state.direction || a.name.localeCompare(b.name);
  });
}

function renderSidebar() {
  $('saved-section').hidden = !state.cachedRoots.length;
  $('saved-scans').innerHTML = state.cachedRoots.slice(0, 4).map(saved => `<button class="nav-item saved-scan-item" data-path="${esc(saved.root)}" title="${esc(saved.root)}">${icon('layers')}<span>${esc(basename(saved.root))}<small>${esc(snapshotTime(saved.scannedAt))}</small></span></button>`).join('');
  $('places').innerHTML = state.places.map(p => `<button class="nav-item${p.path === currentPath() ? ' place-current' : ''}" data-path="${esc(p.path)}">${icon(p.id)}${esc(p.label)}</button>`).join('');
  $('drives').innerHTML = state.drives.length ? state.drives.map(d => `<button class="drive-card${currentPath().toLowerCase().startsWith(d.path.toLowerCase()) ? ' active' : ''}" data-path="${esc(d.path)}"><div class="drive-name">${icon('drive')}<span>${esc(d.label)} <small>(${esc(d.path.replace(/[\\/]+$/, ''))})</small></span></div><div class="drive-track"><i style="width:${d.total ? (1 - d.free / d.total) * 100 : 0}%"></i></div><div class="drive-detail">${formatBytes(d.free, 0)} free of ${formatBytes(d.total, 0)}</div></button>`).join('') : '<p class="sidebar-hint">Drive capacity is unavailable.</p>';
  $('favorites').innerHTML = state.favorites.map(p => `<div class="favorite nav-item"><button class="pin-nav" data-path="${esc(p.path)}" title="${esc(p.path)}">${icon('folder')} ${esc(p.name)}</button><button class="unpin" data-unpin="${esc(p.path)}" title="Unpin folder" aria-label="Unpin ${esc(p.name)}">${icon('close')}</button></div>`).join('');
  $('favorites-hint').hidden = state.favorites.length > 0;
  $('review-count').textContent = state.review.length;
  $('large-count').textContent = state.scan ? Math.min(200, state.scan.fileCount) : '';
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === state.view));
  $('pin-folder').classList.toggle('pinned', state.favorites.some(p => p.path === currentPath()));
}
function renderTabs() {
  $('tabs').innerHTML = state.tabs.map(t => `<button class="tab${t.id === state.activeTab ? ' active' : ''}" role="tab" aria-selected="${t.id === state.activeTab}" data-tab="${t.id}" title="${esc(t.path)}">${icon('folder')}<span class="tab-label">${esc(basename(t.path))}</span><span class="tab-close" data-close-tab="${t.id}" role="button" aria-label="Close tab">${icon('close')}</span></button>`).join('');
  $('back').disabled = !currentTab() || currentTab().historyIndex <= 0;
  $('forward').disabled = !currentTab() || currentTab().historyIndex >= currentTab().history.length - 1;
  $('up').disabled = !state.parent;
}
function renderHeader() {
  $('folder-title').textContent = state.view === 'review' ? 'Review list' : state.view === 'large' ? 'The biggest files.' : basename(currentPath());
  $('folder-eyebrow').textContent = state.view === 'review' ? 'A LITTLE ROOM TO DECIDE' : state.view === 'large' ? 'FIND YOUR SPACE AGAIN' : 'YOUR SPACE, EXPLAINED';
  $('folder-subtitle').textContent = state.view === 'review' ? 'A shortlist to come back to. Adding items never changes your files.' : state.view === 'large' ? 'The 200 largest files found in this folder and its subfolders.' : `${number(state.entries.filter(e => e.isDirectory).length)} folders · ${number(state.entries.filter(e => !e.isDirectory).length)} files${state.scan ? ` · ${formatBytes(state.scan.totalSize)} analyzed` : ' · Folder sizes on demand'}`;
  $('address').value = currentPath();
  window.fxIOS?.syncLocation();
  $('scan-label').textContent = state.scanning ? 'Stop analysis' : state.scan ? 'Analyze again' : 'Analyze folder';
  $('scan').firstElementChild.innerHTML = icon(state.scanning ? 'stop' : 'scan');
  $('export').disabled = !state.scan;
  if (state.scanning) $('export').disabled = true;
  $('snapshot-badge').hidden = !state.scan?.snapshot || state.scanning;
  if (state.scan?.snapshot) { $('snapshot-badge').textContent = `${state.scan.snapshot.stale ? 'Older snapshot' : 'Saved'} · ${snapshotTime(state.scan.snapshot.scannedAt)}`; $('snapshot-badge').title = 'Stored on this device. Analyze again to update sizes after files change.'; }
  $('new-folder').disabled = state.view !== 'browse';
  $('paste').disabled = !state.clipboard || state.view !== 'browse';
  const drive = state.drives.find(d => currentPath().toLowerCase().startsWith(d.path.toLowerCase()));
  $('storage-name').textContent = drive ? `${drive.label} (${drive.path.replace(/[\\/]+$/, '')})` : 'Folder storage';
  $('storage-text').textContent = drive ? `${formatBytes(drive.total - drive.free, 0)} of ${formatBytes(drive.total, 0)} used` : 'Capacity unavailable for this location';
  $('storage-free').textContent = drive ? `${formatBytes(drive.free, 0)} free` : '';
  $('storage-used').style.width = drive?.total ? `${Math.max(0, Math.min(100, (1 - drive.free / drive.total) * 100))}%` : '0%';
  $('map-hint').textContent = state.scanning ? `Live map · ${number(state.scan?.fileCount)} files found` : state.scan ? `${number(state.scan.fileCount)} files${state.scan.snapshot ? ' · Saved on this device' : ` · ${(state.scan.durationMs / 1000).toFixed(1)}s`}${state.scan.truncated ? ' · Partial scan' : ''}${state.scan.snapshot?.limited ? ' · Saved detail limit reached' : ''}` : 'Analyze to see what takes up space';
  $('map-section').classList.toggle('collapsed', state.mapCollapsed);
  document.body.classList.toggle('scanning', state.scanning);
}

function renderList() {
  const entries = effectiveEntries();
  $('list-title').textContent = state.view === 'review' ? 'Saved for review' : state.view === 'large' ? 'Largest files in this folder' : 'Files & folders';
  $('item-count').textContent = number(entries.length);
  const total = state.scan?.totalSize || entries.reduce((max, e) => Math.max(max, e.size || 0), 1);
  $('file-list').innerHTML = entries.slice(0, state.rowLimit).map(e => `<tr class="file-row${state.selected?.path === e.path ? ' selected' : ''}" style="--file-color:${itemColor(e)}" tabindex="0" data-path="${esc(e.path)}" aria-selected="${state.selected?.path === e.path}"><td title="${esc(e.path)}"><div class="file-name">${icon(itemIcon(e), e.isDirectory ? 'folder-icon' : 'file-icon')}<span>${esc(e.name)}</span></div></td><td><div class="file-size"><span>${formatBytes(e.size)}</span>${e.size ? `<span class="size-spark"><i style="width:${Math.min(100, e.size / total * 100)}%"></i></span>` : ''}</div></td><td><span class="type-badge">${esc(type(e))}</span></td><td>${date(e.modified)}</td><td><button class="row-review${reviewed(e.path) ? ' added' : ''}" data-review="${esc(e.path)}" title="${reviewed(e.path) ? 'Remove from review list' : 'Add to review list'}" aria-label="${reviewed(e.path) ? 'Remove from review list' : 'Add to review list'}">${icon('bookmark')}</button></td></tr>`).join('') + (entries.length > state.rowLimit ? `<tr><td colspan="5"><button id="load-more" class="button small">Show next 1,500 items (${number(entries.length - state.rowLimit)} remaining)</button></td></tr>` : '');
  $('list-empty').hidden = entries.length > 0;
  $('list-empty').textContent = state.view === 'review' ? 'Your review list is clear. Bookmark any file or folder to keep it here.' : state.view === 'large' && !state.scan ? 'Analyze a folder to discover its largest files.' : state.query ? 'No items match your filter.' : 'Nothing to see here. This folder is empty, or its items are hidden.';
  document.querySelectorAll('th[data-sort]').forEach(th => { th.querySelector('.sort-mark').textContent = th.dataset.sort === state.sort ? (state.direction === 1 ? '↑' : '↓') : ''; th.setAttribute('aria-sort', th.dataset.sort === state.sort ? (state.direction === 1 ? 'ascending' : 'descending') : 'none'); });
}

// Balanced weighted partitioning keeps rectangles stable and proportional to file bytes.
function partition(items, x, y, w, h, output) {
  if (!items.length) return;
  if (items.length === 1) { output.push({ ...items[0], x, y, w, h }); return; }
  const sum = items.reduce((s, i) => s + i.size, 0);
  let split = 1, first = items[0].size;
  while (split < items.length - 1 && Math.abs(first + items[split].size - sum / 2) < Math.abs(first - sum / 2)) { first += items[split].size; split++; }
  const ratio = first / sum;
  if (w >= h) { partition(items.slice(0, split), x, y, w * ratio, h, output); partition(items.slice(split), x + w * ratio, y, w * (1 - ratio), h, output); }
  else { partition(items.slice(0, split), x, y, w, h * ratio, output); partition(items.slice(split), x, y + h * ratio, w, h * (1 - ratio), output); }
}
function renderMap() {
  const map = $('treemap');
  if (!state.scan) {
    map.innerHTML = state.scanning ? `<div class="map-empty building-map">${icon('scan')}<h3>Building your storage map.</h3><p>Measured folders will appear here as the scan runs.<br>You can stop the analysis at any time.</p><div class="map-color-spectrum"></div></div>` : `<div class="map-empty">${icon('scan')}<h3>See the bigger picture.</h3><p>Analyze this folder to turn your files into a map.<br>Larger blocks mean more space. Your files stay in place.</p><button class="button subtle" id="empty-scan">Analyze this folder ${icon('right')}</button><div class="map-color-spectrum"></div></div>`;
    $('map-legend').innerHTML = '';
    return;
  }
  let items = state.scan.children.filter(e => e.size > 0).map(e => ({ ...e, color: colorHash(e.path || e.name) }));
  if (state.scan.additionalChildren?.size) items.push({ name: `${number(state.scan.additionalChildren.count)} additional items`, size: state.scan.additionalChildren.size, color: '#46515e', path: '' });
  if (!items.length) { map.innerHTML = '<div class="map-empty"><h3>A little breathing room.</h3><p>This scan found no file bytes to visualize.</p></div>'; $('map-legend').innerHTML = ''; return; }
  if (items.length > 60) { const rest = items.slice(59); items = [...items.slice(0, 59), { name: `${rest.length} other items`, size: rest.reduce((a, e) => a + e.size, 0), color: '#46515e', path: '', isDirectory: false }]; }
  const blocks = [];
  partition(items, 0, 0, map.clientWidth, map.clientHeight, blocks);
    map.innerHTML = blocks.map(b => `<button class="map-block${b.w < 115 || b.h < 85 ? ' compact' : ''}${b.w < 42 || b.h < 31 ? ' micro' : ''}${state.selected?.path === b.path ? ' selected' : ''}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;--block-color:${b.color};background:linear-gradient(145deg,${b.color},${b.color}dd)" data-map-path="${esc(b.path)}" title="${esc(b.name)} · ${formatBytes(b.size)}" aria-label="${esc(b.name)}: ${formatBytes(b.size)}">${icon(itemIcon(b))}<span class="block-name">${esc(b.name)}</span><span class="block-size">${formatBytes(b.size)}</span><span class="block-percent">${(b.size / state.scan.totalSize * 100).toFixed(1)}% of folder</span></button>`).join('');
  $('map-legend').innerHTML = items.slice(0, 5).map(e => `<span><i class="legend-dot" style="--legend-color:${e.color};background:${e.color}"></i>${esc(e.name.length > 22 ? e.name.slice(0, 20) + '…' : e.name)}</span>`).join('') + (items.length > 5 ? `<span>+${items.length - 5} more</span>` : '');
}
function renderDetails() {
  const e = state.selected || { name: basename(currentPath()), path: currentPath(), isDirectory: true, size: state.scan?.totalSize ?? null, fileCount: state.scan?.fileCount, folderCount: state.scan?.folderCount };
  const isCurrent = !state.selected;
  const percent = state.scan?.totalSize && e.size != null ? `${(e.size / state.scan.totalSize * 100).toFixed(1)}%` : '—';
  const bytes = formatBytes(e.size).split(' ');
  const categories = state.scan?.categories.filter(c => c.size > 0) || [];
  let offset = 0;
  const circles = categories.map(c => { const length = c.size / state.scan.totalSize * 301.59; const circle = `<circle cx="60" cy="60" r="48" style="--category-color:${categoryColors[c.name] || '#596779'}" stroke="${categoryColors[c.name] || '#596779'}" stroke-dasharray="${Math.max(0, length - 2)} ${301.59 - Math.max(0, length - 2)}" stroke-dashoffset="${-offset}"/>`; offset += length; return circle; }).join('');
  $('detail-content').innerHTML = `<div class="detail-symbol">${icon(itemIcon(e))}</div><h2 class="detail-name">${esc(e.name)}</h2><div class="detail-kind">${esc(type(e))}${isCurrent ? ' · Current location' : ''}</div><div class="detail-size">${esc(bytes[0])}${bytes[1] ? ` <span>${esc(bytes[1])}</span>` : ''}</div><div class="detail-size-label">${e.isDirectory && e.size == null ? 'Analyze to measure this folder' : 'Logical file size'}</div><dl class="detail-meta"><dt>Of folder</dt><dd>${percent}</dd>${e.fileCount != null ? `<dt>Files</dt><dd>${number(e.fileCount)}</dd>` : ''}${e.folderCount != null ? `<dt>Subfolders</dt><dd>${number(e.folderCount)}</dd>` : ''}<dt>Modified</dt><dd>${date(e.modified)}</dd><dt>Location</dt><dd title="${esc(e.path)}">${esc(e.path)}</dd></dl><div class="detail-actions"><button class="button" data-action="reveal">${icon('external')} Reveal</button><button class="button" data-action="${e.isDirectory ? 'enter' : 'preview'}">${icon(e.isDirectory ? 'folder' : 'eye')} ${e.isDirectory ? 'Browse' : 'Preview'}</button><button class="button" data-action="review">${icon(reviewed(e.path) ? 'check' : 'bookmark')} ${reviewed(e.path) ? 'In review' : 'Review later'}</button><button class="button" data-action="copy-path">${icon('copy')} Copy path</button>${!isCurrent ? `<button class="button" data-action="rename">${icon('edit')} Rename</button><button class="button danger" data-action="trash">${icon('trash')} Recycle</button>` : ''}</div><div id="preview-container"></div><div class="detail-divider"></div><h3 class="detail-section-title">Folder composition <span style="color:#58697a;font-size:9px;font-weight:400">/ analyzed location</span></h3><div class="donut-wrap"><svg class="donut" viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" stroke="#2b3541"/>${circles}</svg><div class="donut-center"><small>${state.scan ? 'Total analyzed' : 'Awaiting analysis'}</small><strong>${state.scan ? formatBytes(state.scan.totalSize) : '—'}</strong></div></div>${categories.map(c => `<div class="category-line"><i class="legend-dot" style="--legend-color:${categoryColors[c.name] || '#596779'};background:${categoryColors[c.name] || '#596779'}"></i>${esc(c.name)}<strong>${formatBytes(c.size)}</strong></div>`).join('')}${!categories.length ? '<div class="detail-tip">Analyze a folder to understand what’s inside. Select a block to inspect it; double-click a folder to explore.</div>' : state.scan.skipped || state.scan.truncated ? `<div class="detail-tip">${state.scan.truncated ? 'Partial scan: the configured entry limit was reached. ' : ''}${number(state.scan.skipped)} links or inaccessible items skipped. Results show the files successfully measured.</div>` : ''}`;
}
function renderAll() { renderSidebar(); renderTabs(); renderHeader(); renderList(); renderMap(); renderDetails(); }
async function refreshSavedScans() { try { state.cachedRoots = (await api.cacheInfo()).scans || []; renderSidebar(); } catch {} }
  function entryByPath(p) { return state.entries.find(e => e.path === p) || state.scan?.children.find(e => e.path === p) || state.scan?.largestFiles.find(e => e.path === p) || state.review.find(e => e.path === p); }
function select(p, focus = false) { const entry = entryByPath(p); if (!entry) return; state.selected = entry; document.querySelectorAll('.file-row').forEach(r => { r.classList.toggle('selected', r.dataset.path === p); r.setAttribute('aria-selected', r.dataset.path === p); }); document.querySelectorAll('.map-block').forEach(b => b.classList.toggle('selected', b.dataset.mapPath === p)); renderDetails(); if (focus) Array.from($('file-list').querySelectorAll('.file-row')).find(r => r.dataset.path === p)?.focus(); }

async function navigate(p, options = {}) {
  if (!currentTab()) return newTab(p);
  const id = ++state.navigationId;
  ++state.scanToken;
  if (state.scanning) api.cancelScan().catch(() => {});
  state.scanning = false;
  document.body.classList.add('loading');
  status('Opening folder…');
  try {
    const listing = await api.list(p);
    if (id !== state.navigationId) return;
    const tab = currentTab();
    tab.path = listing.path;
    window.fxSettings?.rememberPath(listing.path);
    if (!options.history) { tab.history = tab.history.slice(0, tab.historyIndex + 1); if (tab.history.at(-1) !== listing.path) tab.history.push(listing.path); tab.historyIndex = tab.history.length - 1; }
    if (options.historyIndex !== undefined) tab.historyIndex = options.historyIndex;
    state.entries = listing.entries.map(e => ({ ...e, size: e.isDirectory ? null : e.size }));
    state.parent = listing.parent;
    state.selected = null;
    const snapshot = options.restore ? tab.snapshot : null;
    state.scan = listing.scan || null;
    previousScan = null;
    mergeMeasured(state.scan);
    if (snapshot) { state.sort = snapshot.sort; state.direction = snapshot.direction; }
    tab.snapshot = null;
    state.view = 'browse';
    state.query = '';
    state.rowLimit = 1500;
    $('search').value = '';
    renderAll();
    if (state.scan?.snapshot) status(`Saved analysis · ${number(state.scan.fileCount)} files · ${formatBytes(state.scan.totalSize)}`, `${state.scan.snapshot.stale ? 'Folder changed since ' : 'Measured '}${snapshotTime(state.scan.snapshot.scannedAt)} · Analyze again to refresh`);
    else status(`${listing.truncated ? 'First ' : ''}${number(state.entries.length)} items`, listing.truncated ? 'Large folder: display is limited to 50,000 entries. Analysis still follows its separate limit.' : 'Double-click folders to explore · Analyze for folder sizes');
  } catch (error) { if (id === state.navigationId) { toast(error.message, true); renderAll(); status('Folder could not be opened', 'Check the path and your Windows access permissions'); } }
  finally { if (id === state.navigationId) document.body.classList.remove('loading'); }
}
async function newTab(p = currentPath()) {
  if (state.tabs.length >= 12) { toast('You can keep up to 12 tabs open.'); return; }
  saveTabSnapshot();
  const id = Date.now() + Math.random();
  state.tabs.push({ id, path: p, history: [], historyIndex: -1 }); state.activeTab = id;
  await navigate(p);
}
async function closeTab(id) {
  if (state.tabs.length === 1) { toast('Keep one tab open for your workspace.'); return; }
  const index = state.tabs.findIndex(t => t.id === id);
  state.tabs.splice(index, 1);
  if (state.activeTab === id) { state.activeTab = state.tabs[Math.min(index, state.tabs.length - 1)].id; await navigate(currentPath(), { history: true, restore: true }); } else renderTabs();
}
function saveTabSnapshot() { const tab = currentTab(); if (tab) tab.snapshot = { sort: state.sort, direction: state.direction }; }
async function historyMove(step) { const tab = currentTab(); const index = tab.historyIndex + step; if (index >= 0 && index < tab.history.length) await navigate(tab.history[index], { history: true, historyIndex: index }); }
async function startScan() {
  if (state.scanning) { ++state.scanToken; state.scanning = false; await api.cancelScan(); state.scan = previousScan; previousScan = null; mergeMeasured(state.scan); renderAll(); status('Analysis stopped', state.scan?.snapshot ? 'Your previous saved analysis is still available.' : 'No new analysis was saved.'); return; }
  const token = ++state.scanToken;
  const target = currentPath();
  previousScan = state.scan;
  state.scanning = true; renderHeader(); renderMap(); status('Analyzing folder…', 'Live results appear as folders are measured.');
  try {
    const response = await api.scan(target, { maxEntries: window.fxSettings?.maxEntries || 250000, retainDepth: window.fxSettings?.retainDepth || 4 });
    if (token !== state.scanToken || target !== currentPath()) return;
    state.scanning = false;
    if (response.canceled) { state.scan = previousScan; previousScan = null; mergeMeasured(state.scan); renderAll(); status('Analysis stopped'); return; }
    state.scan = response.result;
    previousScan = null;
    const measured = new Map(state.scan.children.map(e => [e.path, e]));
    state.entries = state.entries.map(e => measured.has(e.path) ? { ...e, ...measured.get(e.path) } : e);
    if (state.selected) state.selected = entryByPath(state.selected.path) || null;
    state.review = state.review.map(e => measured.has(e.path) ? { ...e, ...measured.get(e.path) } : e);
    saveLocal();
    if (state.view !== 'review') { state.sort = 'size'; state.direction = -1; }
    renderAll();
    status(`${state.scan.truncated ? 'Partial analysis' : 'Analysis complete'} · ${number(state.scan.fileCount)} files · ${formatBytes(state.scan.totalSize)}`, `${number(state.scan.skipped)} skipped · ${(state.scan.durationMs / 1000).toFixed(1)} seconds${state.scan.snapshot ? ` · Saved up to ${state.scan.snapshot.retainDepth} levels deep${state.scan.snapshot.limited ? "; saved detail limited" : ""}` : ' · Could not save scan'}`);
    if (state.scan.cacheError) toast('Analysis complete, but saving failed. Check available disk space and cache folder permissions.', true);
    refreshSavedScans();
  } catch (error) { if (token === state.scanToken) { state.scanning = false; state.scan = previousScan; previousScan = null; renderAll(); toast(error.message, true); status('Analysis could not finish', 'Try a smaller folder or check Windows permissions'); } }
}
function toggleReview(entry = state.selected) {
  if (!entry) entry = { name: basename(currentPath()), path: currentPath(), isDirectory: true, size: state.scan?.totalSize ?? null };
  if (reviewed(entry.path)) state.review = state.review.filter(e => e.path !== entry.path);
  else { if (state.review.length >= 500) { toast('Your review list can hold 500 items.'); return; } state.review.push({ ...entry }); }
  saveLocal(); renderSidebar(); renderList(); renderDetails();
}
function pinFolder() {
  const p = currentPath();
  if (state.favorites.some(e => e.path === p)) state.favorites = state.favorites.filter(e => e.path !== p);
  else { if (state.favorites.length >= 30) { toast('You can pin up to 30 folders.'); return; } state.favorites.push({ name: basename(p), path: p }); }
  saveLocal(); renderSidebar();
}
async function openEntry(entry = state.selected) { if (!entry) return; if (entry.isDirectory) await navigate(entry.path); else await attempt(() => api.open(entry.path)); }
async function preview() {
  const entry = state.selected;
  if (!entry || entry.isDirectory) return;
  $('preview-container').innerHTML = '<div class="preview-box"><p>Loading preview…</p></div>';
  try {
    const result = await api.preview(entry.path);
    if (state.selected?.path !== entry.path) return;
    const container = $('preview-container');
    container.innerHTML = '<div class="preview-box"></div>';
    const box = container.firstElementChild;
    if (result.kind === 'text') { const pre = document.createElement('pre'); pre.textContent = result.content; box.appendChild(pre); }
    else if (result.kind === 'image') { const img = document.createElement('img'); img.src = `data:${result.mime};base64,${result.content}`; img.alt = entry.name; box.appendChild(img); }
    else box.innerHTML = '<p>Preview isn’t available for this format or size. Text previews support up to 128 KB; images up to 8 MB.</p>';
    const open = document.createElement('button'); open.className = 'button small'; open.textContent = 'Open with Windows'; open.addEventListener('click', () => attempt(() => api.open(entry.path))); box.appendChild(open);
  } catch (error) { if (state.selected?.path === entry.path) $('preview-container').innerHTML = '<div class="preview-box"><p>Preview could not be loaded. The item may have moved or is inaccessible.</p></div>'; toast(error.message, true); }
}
async function refresh() { await navigate(currentPath(), { history: true }); }
function askName(kind) {
  const entry = state.selected;
  if (kind === 'rename' && !entry) return;
  $('dialog-title').textContent = kind === 'rename' ? 'A new name.' : 'Make a little space.';
  $('dialog-description').textContent = kind === 'rename' ? `Rename “${entry.name}”.` : 'Create a folder in your current location.';
  $('dialog-submit').textContent = kind === 'rename' ? 'Rename' : 'Create folder';
  $('name-input').value = kind === 'rename' ? entry.name : '';
  $('dialog-error').textContent = '';
  const folder = currentPath();
  dialogAction = async name => {
    if (kind === 'rename') { const destination = await api.rename(entry.path, name); state.review = state.review.map(e => e.path === entry.path ? { ...e, name, path: destination } : e); state.favorites = state.favorites.map(e => e.path === entry.path ? { ...e, name, path: destination } : e); saveLocal(); }
    else await api.newFolder(folder, name);
    await refresh(); toast(kind === 'rename' ? 'Item renamed.' : 'Folder created.');
  };
  $('name-dialog').showModal(); $('name-input').focus(); $('name-input').select();
}
async function recycle() {
  const entry = state.selected;
  if (!entry) return;
  await attempt(async () => {
    if (await api.trash(entry.path)) { state.review = state.review.filter(e => e.path !== entry.path); state.favorites = state.favorites.filter(e => e.path !== entry.path); saveLocal(); await refresh(); toast('Moved to the Recycle Bin.'); }
  });
}
async function copyItem() { if (!state.selected) return; await attempt(async () => { const name = await api.copy(state.selected.path); state.clipboard = true; renderHeader(); toast(`Copied “${name}”. Choose a folder and paste.`); }); }
async function pasteItem() { if (!state.clipboard || state.view !== 'browse') return; $('paste').disabled = true; status('Copying item…', 'Please keep fxplorer open until the copy completes.'); await attempt(async () => { await api.paste(currentPath()); await refresh(); toast('Copy complete.'); }); renderHeader(); }
async function detailAction(action) {
  const entry = state.selected;
  if (action === 'enter') await navigate(entry?.path || currentPath());
  else if (action === 'preview') await preview();
  else if (action === 'review') toggleReview();
  else if (action === 'reveal') await attempt(() => api.reveal(entry?.path || currentPath()));
  else if (action === 'copy-path') await attempt(async () => { await api.copyPath(entry?.path || currentPath()); toast('Path copied to your clipboard.'); });
  else if (action === 'rename') askName('rename');
  else if (action === 'trash') await recycle();
  else if (action === 'open') await openEntry();
  else if (action === 'copy') await copyItem();
}
function showContext(event, p) {
  event.preventDefault(); select(p);
  const menu = $('context-menu');
  menu.innerHTML = [['open', 'external', state.selected.isDirectory ? 'Open folder' : 'Open with Windows'], ['preview', 'eye', 'Preview'], ['copy', 'copy', 'Copy item'], ['copy-path', 'link', 'Copy path'], ['rename', 'edit', 'Rename'], ['review', 'bookmark', reviewed(p) ? 'Remove from review' : 'Review later'], ['reveal', 'folder', 'Reveal in Explorer'], ['trash', 'trash', 'Move to Recycle Bin']].filter(a => !(a[0] === 'preview' && state.selected.isDirectory)).map(([a, i, label]) => `<button role="menuitem" data-action="${a}">${icon(i)}${label}</button>`).join('');
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)}px`;
}

$('choose-folder').addEventListener('click', () => attempt(async () => { const p = await api.chooseFolder(); if (p) await navigate(p); }));
$('scan').addEventListener('click', () => attempt(startScan));
  function mapPath(event) { return event.target.closest('[data-map-path]')?.dataset.mapPath; }
$('treemap').addEventListener('click', event => { if (event.target.closest('#empty-scan')) { attempt(startScan); return; } const p = mapPath(event); if (p) select(p); else if (p === '') toast('Smaller items are grouped here. The file list and folder navigation show more detail.'); });
$('treemap').addEventListener('dblclick', event => { const p = mapPath(event); const entry = p && entryByPath(p); if (!entry) return; if (entry.isDirectory) navigate(entry.path); else { select(entry.path); preview(); } });
$('treemap').addEventListener('contextmenu', event => { const p = mapPath(event); if (p) showContext(event, p); });
$('file-list').addEventListener('click', event => { if (event.target.closest('#load-more')) { state.rowLimit += 1500; renderList(); return; } const button = event.target.closest('[data-review]'); if (button) { toggleReview(entryByPath(button.dataset.review)); return; } const row = event.target.closest('[data-path]'); if (row) select(row.dataset.path); });
$('file-list').addEventListener('dblclick', event => { if (event.target.closest('[data-review]')) return; const row = event.target.closest('[data-path]'); if (row) openEntry(entryByPath(row.dataset.path)); });
$('file-list').addEventListener('contextmenu', event => { const row = event.target.closest('[data-path]'); if (row) showContext(event, row.dataset.path); });
$('file-list').addEventListener('keydown', event => { const row = event.target.closest('[data-path]'); if (!row) return; if (event.key === 'Enter') { event.preventDefault(); openEntry(entryByPath(row.dataset.path)); } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const entries = effectiveEntries(); const index = entries.findIndex(e => e.path === row.dataset.path); const next = entries[index + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) select(next.path, true); } else if (event.key === ' ') { event.preventDefault(); select(row.dataset.path); preview(); } });
$('detail-content').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) attempt(() => detailAction(button.dataset.action)); });
$('context-menu').addEventListener('click', event => { const button = event.target.closest('[data-action]'); $('context-menu').hidden = true; if (button) attempt(() => detailAction(button.dataset.action)); });
document.addEventListener('click', event => { if (!event.target.closest('#context-menu')) $('context-menu').hidden = true; });
document.addEventListener('contextmenu', event => { if (!event.target.closest('.file-row,.map-block')) $('context-menu').hidden = true; });
for (const id of ['places', 'drives', 'favorites', 'saved-scans']) $(id).addEventListener('click', event => { const unpin = event.target.closest('[data-unpin]'); if (unpin) { state.favorites = state.favorites.filter(e => e.path !== unpin.dataset.unpin); saveLocal(); renderSidebar(); return; } const button = event.target.closest('[data-path]'); if (button) navigate(button.dataset.path); });
$('views').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (!button) return; state.view = button.dataset.view; state.selected = null; state.query = ''; state.rowLimit = 1500; $('search').value = ''; if (state.view === 'large') { state.sort = 'size'; state.direction = -1; } renderAll(); });
$('tabs').addEventListener('click', event => { const close = event.target.closest('[data-close-tab]'); if (close) { closeTab(Number(close.dataset.closeTab)); return; } const tab = event.target.closest('[data-tab]'); if (tab && Number(tab.dataset.tab) !== state.activeTab) { saveTabSnapshot(); state.activeTab = Number(tab.dataset.tab); navigate(currentPath(), { history: true, restore: true }); } });
$('new-tab').addEventListener('click', () => newTab());
$('pin-folder').addEventListener('click', pinFolder);
$('back').addEventListener('click', () => historyMove(-1));
$('forward').addEventListener('click', () => historyMove(1));
$('up').addEventListener('click', () => { if (state.parent) navigate(state.parent); });
$('refresh').addEventListener('click', refresh);
$('refresh-drives').addEventListener('click', () => attempt(async () => { state.drives = (await api.bootstrap()).drives; renderSidebar(); renderHeader(); toast('Drive information refreshed.'); }));
$('address').addEventListener('keydown', event => { if (event.key === 'Enter') { navigate(event.target.value.trim()); event.target.blur(); } else if (event.key === 'Escape') { event.target.value = currentPath(); event.target.blur(); } });
$('search').addEventListener('input', event => { state.query = event.target.value; state.rowLimit = 1500; renderList(); });
$('show-hidden').addEventListener('change', event => { state.showHidden = event.target.checked; renderList(); });
document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => { if (state.sort === th.dataset.sort) state.direction *= -1; else { state.sort = th.dataset.sort; state.direction = th.dataset.sort === 'size' ? -1 : 1; } renderList(); }));
$('new-folder').addEventListener('click', () => askName('new'));
$('paste').addEventListener('click', pasteItem);
$('dialog-cancel').addEventListener('click', () => $('name-dialog').close());
$('name-form').addEventListener('submit', async event => { event.preventDefault(); const name = $('name-input').value; $('dialog-submit').disabled = true; try { await dialogAction(name); $('name-dialog').close(); } catch (error) { $('dialog-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); } finally { $('dialog-submit').disabled = false; } });
$('export').addEventListener('click', () => attempt(async () => { if (state.scan && await api.export(state.scan)) toast('Storage report exported.'); }));
$('toggle-map').addEventListener('click', () => { state.mapCollapsed = !state.mapCollapsed; $('map-section').classList.toggle('collapsed', state.mapCollapsed); $('toggle-map').style.transform = state.mapCollapsed ? 'rotate(180deg)' : ''; $('toggle-map').setAttribute('aria-label', state.mapCollapsed ? 'Expand storage map' : 'Collapse storage map'); renderMap(); });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('close-help').addEventListener('click', () => $('help-dialog').close());
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { $('context-menu').hidden = true; $('search').value = ''; state.query = ''; renderList(); return; }
  const typing = event.target.matches('input,textarea');
  if (event.ctrlKey && ['l', 'f', 'k', 'o', 't', 'w'].includes(event.key.toLowerCase())) {
    event.preventDefault(); const key = event.key.toLowerCase();
    if (key === 'l') { $('address').focus(); $('address').select(); }
    else if (key === 'f' || key === 'k') { $('search').focus(); $('search').select(); }
    else if (key === 'o') $('choose-folder').click();
    else if (key === 't') newTab();
    else closeTab(state.activeTab);
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); historyMove(-1); }
  else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); historyMove(1); }
  else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); if (state.parent) navigate(state.parent); }
  else if (event.key === 'F5') { event.preventDefault(); refresh(); }
  else if (event.key === 'F2') { event.preventDefault(); askName('rename'); }
  else if (event.key === 'Delete') { event.preventDefault(); recycle(); }
  else if (event.ctrlKey && event.key.toLowerCase() === 'c') { event.preventDefault(); copyItem(); }
  else if (event.ctrlKey && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteItem(); }
});
let holdMapUntil = 0;
$('treemap').addEventListener('pointerdown', () => { holdMapUntil = Date.now() + 650; });
api?.onProgress(progress => {
  if (!state.scanning || progress.partial?.path?.toLowerCase() !== currentPath().toLowerCase()) return;
  status(`${number(progress.fileCount)} files · ${formatBytes(progress.totalSize)} found`, `Analyzing ${basename(progress.currentPath || currentPath())}…`);
  if (progress.partial?.totalSize > 0) {
    state.scan = progress.partial;
    mergeMeasured(state.scan);
    renderHeader();
    if (Date.now() >= holdMapUntil) renderMap();
    if (!state.selected || state.selected.isDirectory) renderDetails();
    const visibleEntries = new Map(state.entries.map(entry => [entry.path, entry]));
    for (const row of $('file-list').querySelectorAll('.file-row')) {
      const entry = visibleEntries.get(row.dataset.path);
      if (entry?.isDirectory && entry.size != null) { const size = row.querySelector('.file-size>span'); if (size) size.textContent = formatBytes(entry.size); }
    }
  }
});
document.addEventListener('fxplorer:navigate', event => { if (typeof event.detail === 'string') navigate(event.detail); });
document.addEventListener('fxplorer:cache-cleared', () => { ++state.scanToken; state.scanning = false; state.scan = null; previousScan = null; state.selected = null; state.entries = state.entries.map(entry => entry.isDirectory ? { ...entry, size: null, fileCount: undefined, folderCount: undefined } : entry); renderAll(); refreshSavedScans(); status('Saved scans cleared', 'Your files have not changed.'); });
new ResizeObserver(() => { if (state.scan && !state.mapCollapsed) renderMap(); }).observe($('treemap'));

async function boot() {
  if (!api) { status('Desktop runtime required', 'Start fxplorer using its Windows executable.'); $('detail-content').innerHTML = '<div class="detail-tip">Open the fxplorer desktop app to browse local files.</div>'; return; }
  try {
    const info = await api.bootstrap(); state.places = info.places; state.drives = info.drives;
    refreshSavedScans();
    const initial = state.places.find(p => p.id === (window.fxSettings?.startup === 'home' ? 'home' : 'downloads')) || state.places.find(p => p.id === 'home');
    const last = window.fxSettings?.startup === 'last' && typeof window.fxSettings.lastPath === 'string' ? window.fxSettings.lastPath : '';
    if (last || initial) await newTab(last || initial.path); else throw new Error('No accessible starting folder was found.');
  } catch (error) { toast(error.message, true); status('Could not load your workspace', 'Use Open a folder to choose a location.'); }
}
boot();
