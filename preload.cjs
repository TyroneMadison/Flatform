// The only native features the page gets: two pickers and two ways to show a folder. Each is checked again in
// main.mjs. Node and Electron stay out of the page (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flatform', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
  showItemInFolder: (path) => ipcRenderer.invoke('show-item-in-folder', path),
  openPath: (path) => ipcRenderer.invoke('open-path', path),
});
