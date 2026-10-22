// The only native features the page gets: two pickers, two ways to show a folder, Top up, and files opened with
// Flatform. Each is checked again in main.mjs. Node and Electron stay out of the page (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flatform', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
  openBilling: (service) => ipcRenderer.invoke('open-billing', service),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, paths) => cb(paths)),
  readDroppedFile: (path) => ipcRenderer.invoke('read-dropped-file', path), // → { name, bytes }
});
