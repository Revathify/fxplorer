(function () {
  'use strict';

  const STORAGE_KEY = 'fxplorer-layout';
  const LIMITS = { left: { min: 160, max: 420, fallback: 212 }, right: { min: 220, max: 480, fallback: 272 } };
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  function defaultWidth(side) {
    if (window.innerWidth <= 1280) return side === 'left' ? 188 : 245;
    return LIMITS[side].fallback;
  }

  function readPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return {
        left: stored && Number.isFinite(stored.left) ? valid(stored.left, 'left') : null,
        right: stored && Number.isFinite(stored.right) ? valid(stored.right, 'right') : null
      };
    } catch { return { left: null, right: null }; }
  }
  function valid(value, side) { return Math.min(LIMITS[side].max, Math.max(LIMITS[side].min, Math.round(value))); }
  const inspectorVisible = () => !['ios-light', 'ios-dark'].includes(document.documentElement.dataset.theme) || document.documentElement.dataset.detailsVisible !== 'false';
  const minimumCenter = () => ['ios-light', 'ios-dark'].includes(document.documentElement.dataset.theme) ? 600 : 560;
  function availableMax(side) {
    const otherMin = side === 'left' ? (inspectorVisible() ? LIMITS.right.min : 0) : LIMITS.left.min;
    return Math.min(LIMITS[side].max, workspace.clientWidth - minimumCenter() - otherMin);
  }
  let preferred = readPreferences();
  let effective = { ...preferred };
  let dragging = null;

  function constrain() {
    const budget = Math.max(0, workspace.clientWidth - minimumCenter());
    let left = preferred.left ?? defaultWidth('left');
    let right = inspectorVisible() ? (preferred.right ?? defaultWidth('right')) : 0;
    if (left + right > budget) {
      let excess = left + right - budget;
      const leftRoom = left - LIMITS.left.min;
      const rightRoom = right - LIMITS.right.min;
      const leftCut = Math.min(leftRoom, Math.ceil(excess * (leftRoom / Math.max(1, leftRoom + rightRoom))));
      left -= leftCut; excess -= leftCut;
      right -= Math.min(rightRoom, excess);
      if (left + right > budget) left = Math.max(0, budget - right);
    }
    effective = { left, right };
    workspace.style.setProperty('--fxplorer-sidebar-width', `${left}px`);
    workspace.style.setProperty('--fxplorer-inspector-width', `${right}px`);
    for (const side of ['left', 'right']) {
      const handle = workspace.querySelector(`[data-layout-side="${side}"]`);
      handle.setAttribute('aria-valuenow', String(effective[side]));
      handle.setAttribute('aria-valuemax', String(availableMax(side)));
      handle.style.left = side === 'left' ? `${effective.left - 4}px` : '';
      handle.style.right = side === 'right' ? `${effective.right - 4}px` : '';
    }
  }
  function save() {
    try {
      const stored = {};
      for (const side of ['left', 'right']) if (preferred[side] !== null) stored[side] = preferred[side];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch { /* Storage can be disabled. */ }
  }
  function setWidth(side, value, persist = true) {
    const { min } = LIMITS[side];
    const budget = Math.max(0, workspace.clientWidth - minimumCenter());
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherMin = otherSide === 'right' && !inspectorVisible() ? 0 : LIMITS[otherSide].min;
    preferred[side] = Math.max(min, Math.min(value, availableMax(side), budget - otherMin));
    const otherPreferred = otherSide === 'right' && !inspectorVisible() ? 0 : (preferred[otherSide] ?? effective[otherSide]);
    if (preferred[side] + otherPreferred > budget) {
      preferred[otherSide] = Math.max(otherMin, budget - preferred[side]);
    }
    constrain();
    if (persist) save();
    workspace.dispatchEvent(new CustomEvent('layoutchange', { detail: { ...effective } }));
  }
  function cleanup() {
    if (!dragging) return;
    const { handle, pointerId } = dragging;
    dragging = null;
    document.body.classList.remove('layout-resizing');
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', cleanup);
    handle.removeEventListener('pointercancel', cleanup);
    handle.removeEventListener('lostpointercapture', cleanup);
    window.removeEventListener('blur', cleanup);
    try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Capture may already be gone. */ }
  }
  function onMove(event) {
    if (!dragging || (event.pointerId !== undefined && event.pointerId !== dragging.pointerId)) return;
    const rect = workspace.getBoundingClientRect();
    setWidth(dragging.side, dragging.side === 'left' ? event.clientX - rect.left : rect.right - event.clientX);
  }
  for (const [side, label] of [['left', 'Resize navigation panel'], ['right', 'Resize details panel']]) {
    const handle = document.createElement('div');
    handle.className = 'layout-separator';
    handle.dataset.layoutSide = side;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', label);
    handle.setAttribute('aria-valuemin', String(LIMITS[side].min));
    handle.setAttribute('aria-valuemax', String(LIMITS[side].max));
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = { side, handle, pointerId: event.pointerId };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('layout-resizing');
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', cleanup);
      handle.addEventListener('pointercancel', cleanup);
      handle.addEventListener('lostpointercapture', cleanup);
      window.addEventListener('blur', cleanup);
    });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') setWidth(side, LIMITS[side].min);
      else if (event.key === 'End') setWidth(side, availableMax(side));
      else {
        const sign = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
        setWidth(side, effective[side] + sign * (event.shiftKey ? 40 : 10));
      }
    });
    handle.addEventListener('dblclick', () => {
      preferred[side] = null;
      constrain(); save();
      workspace.dispatchEvent(new CustomEvent('layoutchange', { detail: { ...effective } }));
    });
    workspace.append(handle);
  }
  constrain();
  window.addEventListener('resize', constrain);
  new MutationObserver(constrain).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-details-visible'] });
}());
