// Electron shell: runs the app server inside the app and shows it in a window.
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './server.mjs';

if (!app.requestSingleInstanceLock()) app.quit();

// The Tripo API key is encrypted by the OS (Windows DPAPI / macOS Keychain) before it touches disk.
const keyFile = () => path.join(app.getPath('userData'), 'tripo-key.bin');
let apiKey;
const keyStore = {
  get: () => apiKey,
  set(key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot store the key securely');
    writeFileSync(keyFile(), safeStorage.encryptString(key));
    apiKey = key;
  },
};

let win;
function createWindow(port) {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 520,
    backgroundColor: '#0f1115', title: 'Tripo Studio', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const origin = `http://127.0.0.1:${port}`;
  // Links to other sites (like the Tripo key page) open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });
  win.loadURL(origin);
}

app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

app.whenReady().then(async () => {
  if (existsSync(keyFile())) {
    try { apiKey = safeStorage.decryptString(readFileSync(keyFile())); } catch { /* unreadable key: ask again */ }
  }
  const { port } = await startServer({
    dataDir: path.join(app.getPath('userData'), 'library'),
    keyStore,
    ...(app.isPackaged && { viewerPath: path.join(process.resourcesPath, 'model-viewer.min.js') }),
  });
  console.log(`Tripo Studio server on 127.0.0.1:${port}`);
  createWindow(port);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
