'use strict';
(() => {
  const root = document.documentElement;
  const sidebar = document.querySelector('.sidebar');
  const main = document.querySelector('.main');
  const inspector = document.querySelector('.inspector');
  const content = document.querySelector('.content');
  const navigation = document.querySelector('.navigation');
  const heading = document.querySelector('.folder-header');
  const headingLine = document.querySelector('.heading-line');
  const history = document.querySelector('.history-controls');
  const address = document.getElementById('address');
  const tabs = document.getElementById('tabs');
  const sidebarNodes = [...sidebar.children];
  const mainNodes = [...main.children];
  const contentNodes = [...content.children];
  const inspectorNodes = [...inspector.children];
  const labels = new Map([...sidebar.querySelectorAll('.eyebrow'), inspector.querySelector('.eyebrow')].map(node => [node, node.textContent]));
  const make = className => { const node = document.createElement('div'); node.className = className; return node; };
  const sidebarCard = make('ios-sidebar-card');
  const sidebarHeading = make('ios-sidebar-heading');
  sidebarHeading.innerHTML = '<h2>Files</h2><span>fxplorer</span>';
  const sidebarScroll = make('ios-sidebar-scroll');
  const sidebarFooter = make('ios-sidebar-footer');
  sidebarCard.append(sidebarHeading, sidebarScroll, sidebarFooter);
  const mainCard = make('ios-main-card');
  const inspectorCard = make('ios-inspector-card');
  const detailsToggle = document.createElement('button');
  detailsToggle.id = 'ios-toggle-details'; detailsToggle.className = 'icon-button'; detailsToggle.type = 'button'; detailsToggle.innerHTML = icon('panel');
  const location = document.createElement('button');
  location.id = 'ios-location'; location.className = 'ios-location-button'; location.type = 'button';
  location.setAttribute('aria-label', 'Edit folder path');
  const viewSwitch = make('ios-view-switch'); viewSwitch.setAttribute('role', 'group'); viewSwitch.setAttribute('aria-label', 'File view');
  viewSwitch.innerHTML = `<button id="ios-list-view" type="button" aria-label="List view" title="List view">${icon('list-view')}</button><button id="ios-grid-view" type="button" aria-label="Grid view" title="Grid view">${icon('grid-view')}</button>`;
  let active = false;
  let detailsVisible = false;
  try { detailsVisible = localStorage.getItem('fxplorer-ios-details-visible') === 'true'; } catch {}
  function updateDetails() {
    root.dataset.detailsVisible = String(detailsVisible);
    detailsToggle.setAttribute('aria-expanded', String(detailsVisible));
    detailsToggle.setAttribute('aria-label', detailsVisible ? 'Hide details' : 'Show details');
    detailsToggle.title = detailsVisible ? 'Hide details' : 'Show details';
    window.dispatchEvent(new Event('resize'));
  }
  detailsToggle.addEventListener('click', () => { detailsVisible = !detailsVisible; updateDetails(); try { localStorage.setItem('fxplorer-ios-details-visible', String(detailsVisible)); } catch {} });
  let fileLayout = 'grid';
  try { if (localStorage.getItem('fxplorer-ios-file-layout') === 'list') fileLayout = 'list'; } catch {}
  function updateView() {
    root.dataset.fileLayout = fileLayout;
    viewSwitch.querySelectorAll('button').forEach(button => { const selected = button.id === `ios-${fileLayout}-view`; button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('active', selected); });
  }
  function updateTabs() { root.dataset.singleTab = String(tabs.children.length <= 1); }
  function syncLocation() {
    const path = address.value;
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    const text = parts.length > 2 ? `${parts[parts.length - 2]}  ›  ${parts[parts.length - 1]}` : parts.join('  ›  ') || 'Browse';
    const name = document.createElement('span'); name.textContent = text;
    location.innerHTML = icon('folder'); location.append(name);
    location.title = path || 'Edit folder path';
  }
  function editPath() {
    root.dataset.editingPath = 'true';
    address.focus(); address.select();
  }
  location.addEventListener('click', editPath);
  address.addEventListener('focus', () => { if (active) root.dataset.editingPath = 'true'; });
  address.addEventListener('blur', () => { root.dataset.editingPath = 'false'; });
  address.addEventListener('keydown', event => { if (active && event.key === 'Escape') { root.dataset.editingPath = 'false'; location.focus(); } });
  document.addEventListener('keydown', event => {
    if (active && event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); editPath(); }
  }, true);
  viewSwitch.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    fileLayout = button.id === 'ios-grid-view' ? 'grid' : 'list'; updateView();
    try { localStorage.setItem('fxplorer-ios-file-layout', fileLayout); } catch {}
  });
  function activate() {
    sidebarNodes.forEach(node => {
      if (['choose-folder', 'settings-button'].includes(node.id) || node.classList.contains('sidebar-bottom')) sidebarFooter.append(node);
      else sidebarScroll.append(node);
    });
    sidebar.append(sidebarCard);
    mainCard.append(heading, mainNodes[0], content, mainNodes[mainNodes.length - 1]);
    main.append(mainCard);
    content.prepend(navigation);
    headingLine.prepend(history);
    navigation.prepend(location);
    document.querySelector('.file-tools').prepend(viewSwitch);
    document.querySelector('.heading-actions').append(document.getElementById('new-tab'));
    document.querySelector('.heading-actions').append(detailsToggle);
    inspectorCard.append(...inspectorNodes); inspector.append(inspectorCard);
    const names = { WORKSPACE: 'Library', 'QUICK ACCESS': 'Favorites', 'YOUR DRIVES': 'Locations', 'SAVED ANALYSES': 'Storage reports', 'PINNED FOLDERS': 'Pinned', 'AT A GLANCE': 'Details' };
    for (const [node, oldText] of labels) node.textContent = names[oldText] || oldText;
    root.dataset.iosWorkspace = 'true';
    updateView(); updateTabs(); syncLocation(); updateDetails();
  }
  function deactivate() {
    viewSwitch.remove(); location.remove(); detailsToggle.remove();
    mainNodes[0].append(document.getElementById('new-tab'));
    navigation.prepend(history);
    content.append(...contentNodes);
    main.append(...mainNodes);
    sidebar.append(...sidebarNodes);
    inspector.append(...inspectorNodes);
    sidebarCard.remove(); mainCard.remove(); inspectorCard.remove();
    for (const [node, oldText] of labels) node.textContent = oldText;
    root.dataset.iosWorkspace = 'false'; root.dataset.editingPath = 'false';
  }
  function applyTheme() {
    const next = ['ios-light', 'ios-dark'].includes(root.dataset.theme);
    if (next === active) return;
    active = next;
    if (active) activate(); else deactivate();
    window.dispatchEvent(new Event('resize'));
  }
  window.fxIOS = { syncLocation };
  new MutationObserver(applyTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver(updateTabs).observe(tabs, { childList: true });
  applyTheme();
})();
