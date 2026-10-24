const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('fxplorer', {
  cachedScan: invoke('cached-scan'), cacheInfo: invoke('cache-info'), clearCache: invoke('clear-cache'), revealCache: invoke('reveal-cache'),
  appearance: invoke('appearance'), openDiagnostics: invoke('open-diagnostics'),
  bootstrap: invoke('bootstrap'), list: invoke('list'), chooseFolder: invoke('choose-folder'), scan: invoke('scan'), cancelScan: invoke('cancel-scan'), preview: invoke('preview'), open: invoke('open'), reveal: invoke('reveal'), copyPath: invoke('copy-path'), copy: invoke('copy'), paste: invoke('paste'), rename: invoke('rename'), newFolder: invoke('new-folder'), trash: invoke('trash'), export: invoke('export'),
  onProgress(callback) { const listener = (_event, progress) => callback(progress); ipcRenderer.on('scan-progress', listener); return () => ipcRenderer.removeListener('scan-progress', listener); }
});
