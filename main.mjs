// Electron shell: runs the app server inside the app and shows it in a window.
import { app, BrowserWindow, safeStorage, shell, ipcMain, dialog } from 'electron';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createKeyStore } from './keys.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

if (!app.requestSingleInstanceLock()) app.quit();

// The app used to be called "Tripo Studio". Move its library and saved key once so an upgrade keeps them.
// (On a Mac the old key can't be decrypted under the new name, so the app asks for it again.)
function migrateOldData() {
  const oldDir = path.join(app.getPath('appData'), 'Tripo Studio');
  const dir = app.getPath('userData');
  for (const name of ['library', 'tripo-key.bin']) {
    const from = path.join(oldDir, name);
    const to = path.join(dir, name);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dir, { recursive: true });
      renameSync(from, to);
    }
  }
}

let win;
let origin;

// Native helpers for the page (see preload.cjs). Only our own page may call them, and every argument is checked.
const sameOrigin = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
const fromApp = (e) => e.sender === win?.webContents && sameOrigin(e.senderFrame?.url);
const existingPath = (p) => typeof p === 'string' && path.isAbsolute(p) && existsSync(p);
const validFilters = (filters) => Array.isArray(filters) && filters.length <= 10 && filters.every((f) => f
  && typeof f.name === 'string' && f.name.length <= 100 && Array.isArray(f.extensions) && f.extensions.length <= 20
  && f.extensions.every((x) => typeof x === 'string' && /^(\*|[a-z0-9]{1,10})$/i.test(x)));

ipcMain.handle('pick-folder', async (e) => {
  if (!fromApp(e)) throw new Error('Not allowed');
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-file', async (e, filters) => {
  if (!fromApp(e) || !validFilters(filters)) throw new Error('Not allowed');
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters.map((f) => ({ name: f.name, extensions: f.extensions })) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('show-item-in-folder', (e, p) => {
  if (!fromApp(e) || !existingPath(p)) throw new Error('Not allowed');
  shell.showItemInFolder(p);
});
ipcMain.handle('open-path', async (e, p) => {
  // Folders only: "opening" a file would run it with its default program.
  if (!fromApp(e) || !existingPath(p) || !statSync(p).isDirectory()) throw new Error('Not allowed');
  const error = await shell.openPath(p);
  if (error) throw new Error(error);
});

function createWindow(port) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#070605', title: 'Flatform', autoHideMenuBar: true,
    // The page draws the 38 px title bar; the system window buttons sit on top of it.
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#050404', symbolColor: '#ff9a88', height: 38 },
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(ROOT, 'preload.cjs') },
  });
  origin = `http://127.0.0.1:${port}`;
  // Links to other sites (like the Tripo key page) open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) e.preventDefault();
  });
  win.loadURL(origin);
}

app.on('second-instance', () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

app.whenReady().then(async () => {
  migrateOldData();
  // API keys are encrypted by the OS (Windows DPAPI / macOS Keychain) before they touch disk. The Tripo key saved by
  // v0.3 (userData/tripo-key.bin) is moved into the per-provider store on first launch; see keys.mjs.
  const keyStore = createKeyStore({
    dir: app.getPath('userData'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    env: process.env,
  });
  const { port } = await startServer({
    dataDir: path.join(app.getPath('userData'), 'library'),
    keyStore,
    // Blender runs the render script as a separate program, so it can't be read from inside app.asar.
    // The three.js addons ship next to it because electron-builder leaves dependencies' examples/ folders out.
    ...(app.isPackaged && {
      blenderScript: path.join(process.resourcesPath, 'render', 'blender_turntable.py'),
      threeAddons: path.join(process.resourcesPath, 'three', 'examples', 'jsm'),
    }),
  });
  console.log(`Flatform server on 127.0.0.1:${port}`);
  createWindow(port);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
