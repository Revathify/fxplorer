'use strict';
(() => {
  const palettes = {
    'nox-amethyst': { name: 'Nox Amethyst', base: '#141414', energy: '#7E49B3', highlight: '#CFCFCF' },
    'neon-maritime': { name: 'Neon Maritime', base: '#0038BD', energy: '#EF8E01', highlight: '#EEEEEE' },
    'obsidian-orchid': { name: 'Obsidian Orchid', base: '#303030', energy: '#BA55D3', highlight: '#87CEFA' },
    'obsidian-guava': { name: 'Obsidian Guava', base: '#4C1413', energy: '#EA6B7E', highlight: '#FFDBED' },
    'resolute-vermilion': { name: 'Resolute Vermilion', base: '#2E4C8C', energy: '#FA2D1A', highlight: '#FFF4E2' },
    'mulberry-marina': { name: 'Mulberry Marina', base: '#34151B', energy: '#265275', highlight: '#DA5E5E' },
    'obsidian-neon': { name: 'Obsidian Neon', base: '#0C0E09', energy: '#FF2070', highlight: '#FCFF1A' }
  };
  const customThemes = ['pastel', 'ios-light', 'ios-dark'];
  const previewEdition = document.documentElement.dataset.edition === 'ios-preview';
  const defaults = { theme: previewEdition ? 'ios-light' : 'dark', accent: 'mint', density: 'comfortable', motion: true, glassLevel: 3, solidPanels: false, maxEntries: 250000, retainDepth: 4, startup: 'downloads', lastPath: '' };
  let stored;
  try { stored = JSON.parse(localStorage.getItem('fxplorer-settings')); } catch {}
  const settings = { ...defaults, ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) };
  if (!['dark', 'light', 'system', ...customThemes, ...Object.keys(palettes)].includes(settings.theme)) settings.theme = defaults.theme;
  if (!['mint', 'blue', 'lavender', ...Object.keys(palettes)].includes(settings.accent)) settings.accent = 'mint';
  if (!['comfortable', 'compact'].includes(settings.density)) settings.density = 'comfortable';
  if (![100000, 250000, 1000000].includes(settings.maxEntries)) settings.maxEntries = 250000;
  if (![3, 4, 6].includes(settings.retainDepth)) settings.retainDepth = 4;
  settings.glassLevel = Math.max(1, Math.min(5, Math.round(Number(settings.glassLevel)) || 3));
  settings.solidPanels = Boolean(settings.solidPanels);
  if (!['downloads', 'home', 'last'].includes(settings.startup)) settings.startup = 'downloads';
  function save() { try { localStorage.setItem('fxplorer-settings', JSON.stringify(settings)); } catch {} }
  async function apply() {
    const root = document.documentElement;
    const isPalette = Boolean(palettes[settings.theme]);
    const resolved = isPalette ? 'dark' : settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme;
    root.dataset.theme = isPalette ? settings.theme : resolved;
    const accentPalette = palettes[settings.accent];
    root.dataset.accent = accentPalette ? settings.accent : settings.accent;
    root.style.setProperty('--palette-base', (palettes[settings.theme] || accentPalette || {}).base || '');
    root.style.setProperty('--palette-energy', (palettes[settings.theme] || accentPalette || {}).energy || '');
    root.style.setProperty('--palette-highlight', (palettes[settings.theme] || accentPalette || {}).highlight || '');
    root.style.setProperty('--palette-ink', ['nox-amethyst', 'mulberry-marina'].includes(settings.theme) ? '#ffffff' : '#101114');
    root.dataset.density = settings.density;
    root.dataset.motion = settings.motion ? 'on' : 'off';
    root.dataset.glassLevel = String(settings.glassLevel);
    root.dataset.solid = settings.solidPanels ? 'true' : 'false';
    try {
      const response = await window.fxplorer?.appearance(settings.theme);
      if (response && !isPalette && !customThemes.includes(settings.theme)) root.dataset.theme = response.dark ? 'dark' : 'light';
      else if (isPalette) root.dataset.theme = settings.theme;
    } catch {}
  }
  window.fxSettings = settings;
  settings.rememberPath = path => { settings.lastPath = path; save(); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') apply(); });
  apply();
  const launch = document.createElement('button');
  launch.id = 'settings-button'; launch.className = 'nav-item settings-launch'; launch.title = 'App settings · Ctrl+,';
  launch.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" aria-hidden="true"><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg><span>Settings</span>';
  document.querySelector('.sidebar-bottom').before(launch);
  const modal = document.createElement('dialog');
  modal.id = 'settings-dialog'; modal.className = 'settings-dialog';
  const paletteCards = Object.entries(palettes).map(([id, p]) => `<button class="palette-card" data-theme-choice="${id}" role="radio" aria-label="${p.name}"><span class="palette-swatches"><i style="--swatch:${p.base}"></i><i style="--swatch:${p.energy}"></i><i style="--swatch:${p.highlight}"></i></span><span>${p.name}</span></button>`).join('');
  modal.innerHTML = `<div class="settings-head"><div><span class="eyebrow">MAKE YOURSELF AT HOME</span><h2>Settings</h2></div><button class="icon-button" id="close-settings" aria-label="Close settings">${icon('close')}</button></div><section class="settings-section"><h3>Appearance</h3><p>A workspace that feels right for you.</p><div class="theme-options" role="radiogroup" aria-label="App theme"><button data-theme-choice="dark" role="radio"><span class="theme-preview dark-preview"><i></i><b></b></span>Dark</button><button data-theme-choice="light" role="radio"><span class="theme-preview light-preview"><i></i><b></b></span>Light</button><button data-theme-choice="system" role="radio"><span class="theme-preview system-preview"><i></i><b></b></span>Use Windows setting</button></div><p class="palette-label">Refractive Glass palettes</p><div class="palette-grid" role="radiogroup" aria-label="Palette theme">${paletteCards}</div><div class="setting-row"><label for="setting-accent">Accent color<small>Choose a standard color or one of the palette energies.</small></label><select id="setting-accent"><option value="mint">Mint</option><option value="blue">Blue</option><option value="lavender">Lavender</option>${Object.entries(palettes).map(([id,p])=>`<option value="${id}">${p.name}</option>`).join('')}</select></div><div class="setting-row"><label for="setting-glass">Glass intensity<small>Five levels of frosted depth and surface sheen.</small></label><select id="setting-glass"><option value="1">1 · Subtle</option><option value="2">2 · Classic</option><option value="3">3 · Glassy</option><option value="4">4 · Crystal</option><option value="5">5 · Refractive</option></select></div><div class="setting-row"><label for="setting-solid">Solid panels<small>Use opaque surfaces for extra clarity.</small></label><input type="checkbox" id="setting-solid"></div><div class="setting-row"><label for="setting-density">File list density<small>Fit more files on your screen.</small></label><select id="setting-density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div><div class="setting-row"><label for="setting-motion">Interface animation<small>Your Windows reduced-motion preference is always respected.</small></label><input type="checkbox" id="setting-motion"></div></section><section class="settings-section"><h3>Browsing & analysis</h3><div class="setting-row"><label for="setting-startup">Start in<small>Choose where fxplorer opens.</small></label><select id="setting-startup"><option value="downloads">Downloads</option><option value="home">Home</option><option value="last">Last opened folder</option></select></div><div class="setting-row"><label for="setting-limit">Analysis entry limit<small>Large scans stay in a separate process. Partial scans are labelled.</small></label><select id="setting-limit"><option value="100000">100,000 · quick</option><option value="250000">250,000 · balanced</option><option value="1000000">1,000,000 · extended</option></select></div><p class="settings-note">Scans stream filesystem metadata, skip links and inaccessible locations, and never modify files. Changing the limit applies to your next analysis.</p></section><section class="settings-section settings-about"><div><h3>fxplorer <span id="settings-version">0.5.1 · iOS preview</span></h3><p>Windows x64 · Your files stay on your device.</p></div><button class="button small" id="open-diagnostics">${icon('file')} Open diagnostics log</button></section><div class="settings-footer"><span id="settings-saved">Preferences are saved automatically.</span><button id="reset-settings" class="button small">Restore defaults</button></div>`;
  document.body.appendChild(modal);
  const pastelButton = document.createElement('button');
  pastelButton.dataset.themeChoice = 'pastel'; pastelButton.setAttribute('role', 'radio');
  pastelButton.innerHTML = '<span class="theme-preview pastel-preview"><i></i><b></b></span>Pastel UI';
  modal.querySelector('.theme-options').appendChild(pastelButton);
  const pastelNote = document.createElement('p'); pastelNote.id = 'pastel-note'; pastelNote.className = 'pastel-note'; pastelNote.hidden = true;
  pastelNote.textContent = 'Soft colors, rounded cards and a calm sage accent. Pastel UI has its own appearance; glass controls apply to the Refractive Glass themes.';
  modal.querySelector('.theme-options').after(pastelNote);
  const iosOptions = document.createElement('div'); iosOptions.className = 'ios-theme-options';
  iosOptions.innerHTML = '<p class="palette-label">iOS-inspired workspace</p><div class="theme-options" role="radiogroup" aria-label="iOS-inspired appearance"><button data-theme-choice="ios-light" role="radio"><span class="theme-preview ios-light-preview"><i></i><b></b></span>iOS Light</button><button data-theme-choice="ios-dark" role="radio"><span class="theme-preview ios-dark-preview"><i></i><b></b></span>iOS Dark</button></div><p class="ios-theme-note">Rounded controls, grouped surfaces and system blue. Solid panels reduces transparency. Your saved glass preferences are kept when you switch styles.</p>';
  modal.querySelector('.palette-label').before(iosOptions);
  const themeCredit = document.createElement('p'); themeCredit.className = 'theme-credit';
  themeCredit.textContent = 'Pastel UI theme adapted from Pastel UI Kit by Priyanka Kumari · CC BY 4.0. Nunito font · SIL Open Font License.';
  themeCredit.title = 'Reference: https://www.figma.com/community/file/1255962382215173014/pastel-ui-kit';
  modal.querySelector('.settings-about').after(themeCredit);
  const depthRow = document.createElement('div');
  depthRow.className = 'setting-row';
  depthRow.innerHTML = '<label for="setting-depth">Saved subfolder detail<small>Open analyzed subfolders without scanning again. Files deeper than this are still included in totals.</small></label><select id="setting-depth"><option value="3">3 levels deep</option><option value="4">4 levels deep</option><option value="6">6 levels deep</option></select>';
  modal.querySelector('.settings-note').before(depthRow);
  const cacheSection = document.createElement('section'); cacheSection.className = 'settings-section'; cacheSection.id = 'cache-settings';
  cacheSection.innerHTML = `<h3>Saved analyses</h3><p id="cache-summary" class="cache-note">Loading saved scans…</p><code id="cache-location" class="cache-location"></code><div class="cache-actions"><button id="reveal-cache" class="button small">${icon('folder')} Open storage folder</button><button id="clear-cache" class="button small">${icon('trash')} Clear saved scans</button></div><p class="cache-note">Only folder sizes, names and scan metadata are saved. File contents stay in place. Up to 12 analyses / 256 MB are retained; the oldest are removed when needed. Results are snapshots: analyze again after external file changes.</p><div id="cache-scan-list" class="cache-scan-list"></div>`;
  modal.querySelector('.settings-about').before(cacheSection);
  const el = id => document.getElementById(id);
  function sync() {
    modal.querySelectorAll('[data-theme-choice]').forEach(button => { const selected = button.dataset.themeChoice === settings.theme; button.classList.toggle('chosen', selected); button.setAttribute('aria-checked', selected); });
    el('setting-accent').value = settings.accent; el('setting-glass').value = settings.glassLevel; el('setting-solid').checked = settings.solidPanels; el('setting-density').value = settings.density; el('setting-motion').checked = Boolean(settings.motion); el('setting-startup').value = settings.startup; el('setting-limit').value = settings.maxEntries; el('setting-depth').value = settings.retainDepth;
    const pastel = settings.theme === 'pastel';
    const ios = settings.theme === 'ios-light' || settings.theme === 'ios-dark';
    for (const id of ['setting-accent', 'setting-glass']) el(id).disabled = pastel || ios;
    el('setting-solid').disabled = pastel;
    pastelNote.hidden = !pastel;
  }
  function changed() { save(); apply(); sync(); el('settings-saved').textContent = 'Saved on this device.'; }
  async function loadCacheInfo() {
    try {
      const info = await window.fxplorer.cacheInfo();
      el('cache-summary').textContent = `${info.bundles} saved analyses · ${info.snapshots.toLocaleString()} folders · ${(info.bytes / 1024 / 1024).toFixed(1)} MB on disk`;
      el('cache-location').textContent = info.directory;
      el('clear-cache').disabled = info.bundles === 0;
      el('cache-scan-list').replaceChildren();
      for (const scan of info.scans || []) {
        const button = document.createElement('button'); const name = document.createElement('span'); const time = document.createElement('small');
        name.textContent = scan.root; time.textContent = new Date(scan.scannedAt).toLocaleDateString(); button.append(name, time);
        button.addEventListener('click', () => { modal.close(); document.dispatchEvent(new CustomEvent('fxplorer:navigate', { detail: scan.root })); });
        el('cache-scan-list').appendChild(button);
      }
    } catch { el('cache-summary').textContent = 'Saved scan information is unavailable.'; }
  }
  function open() { sync(); modal.showModal(); loadCacheInfo(); }
  launch.addEventListener('click', open);
  el('close-settings').addEventListener('click', () => modal.close());
  modal.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => { settings.theme = button.dataset.themeChoice; changed(); }));
  for (const [id, key] of [['setting-accent', 'accent'], ['setting-density', 'density'], ['setting-startup', 'startup'], ['setting-limit', 'maxEntries']]) el(id).addEventListener('change', event => { settings[key] = key === 'maxEntries' ? Number(event.target.value) : event.target.value; changed(); });
  el('setting-glass').addEventListener('change', event => { settings.glassLevel = Number(event.target.value); changed(); });
  el('setting-depth').addEventListener('change', event => { settings.retainDepth = Number(event.target.value); changed(); });
  el('setting-solid').addEventListener('change', event => { settings.solidPanels = event.target.checked; changed(); });
  el('setting-motion').addEventListener('change', event => { settings.motion = event.target.checked; changed(); });
  el('reset-settings').addEventListener('click', () => { Object.assign(settings, defaults); changed(); });
  el('open-diagnostics').addEventListener('click', async () => { try { await window.fxplorer.openDiagnostics(); } catch { el('settings-saved').textContent = 'Could not open diagnostics. Try restarting fxplorer.'; } });
  el('reveal-cache').addEventListener('click', async () => { try { await window.fxplorer.revealCache(); } catch { el('cache-summary').textContent = 'Could not open the saved scan folder.'; } });
  el('clear-cache').addEventListener('click', async () => { el('clear-cache').disabled = true; try { await window.fxplorer.clearCache(); document.dispatchEvent(new CustomEvent('fxplorer:cache-cleared')); await loadCacheInfo(); } catch { el('cache-summary').textContent = 'Could not clear saved scans. Try again after the current analysis stops.'; } });
  document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === ',') { event.preventDefault(); if (!modal.open && !document.querySelector('dialog[open]')) open(); } });
})();
