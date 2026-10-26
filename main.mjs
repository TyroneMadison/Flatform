// Electron shell: runs the app server inside the app and shows it in a window.
import { app, BrowserWindow, safeStorage, shell, ipcMain, dialog, Notification, powerSaveBlocker } from 'electron';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, suggestedOutputRoot } from './server.mjs';
import { createKeyStore } from './keys.mjs';
import { updateOptions } from './updates.mjs';
import { PROVIDERS } from './public/lib/engines.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// One Flatform at a time. The lock is per userData folder (%APPDATA%\Flatform), the same for `npm run app` and the
// installed app. A second launch hands its files to the first one (see 'second-instance') and quits.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
// Same as package.json build.appId, so dev and installed builds share one taskbar and notification identity.
if (process.platform === 'win32') app.setAppUserModelId('io.github.tyronemadison.tripostudio');

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
// Top up: the page names a provider, never a URL.
const BILLING = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.billingUrl]).filter(([, url]) => /^https:\/\/[^/]+\//.test(url || '')));
ipcMain.handle('open-billing', (e, service) => {
  if (!fromApp(e) || !Object.hasOwn(BILLING, service)) throw new Error('Not allowed');
  return shell.openExternal(BILLING[service]);
});

// Photos and models opened with Flatform (Explorer "Open with", dragging onto the exe, a second launch). Main sends
// their paths; the page reads each one back once, and only paths main offered.
const OPENABLE = /\.(jpe?g|png|heic|heif|webp|glb|gltf|fbx|obj|usdz)$/i;
const MAX_OPEN = 300 * 1024 * 1024;
const offered = new Set();
const openable = (p) => existingPath(p) && OPENABLE.test(p) && statSync(p).isFile() && statSync(p).size < MAX_OPEN;
function openFiles(argv) {
  const files = argv.filter(openable).map((p) => path.resolve(p));
  if (!files.length || !win) return;
  for (const f of files) offered.add(f);
  win.webContents.send('open-files', files);
}
ipcMain.handle('read-dropped-file', async (e, p) => {
  if (!fromApp(e) || !offered.has(p) || !openable(p)) throw new Error('Not allowed');
  offered.delete(p);
  return { name: path.basename(p), bytes: await readFile(p) };
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
  win.webContents.once('did-finish-load', () => openFiles(process.argv)); // files this first launch was opened with
  win.loadURL(origin);
}

app.on('second-instance', (e, argv) => {
  if (!win) return; // still starting; ponytail: files from a launch this early are dropped
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  openFiles(argv);
});

// Low balance: one system notification per provider per session; the page shows its banner each time.
const warned = new Set();
function notifyLow(service, { balance, threshold }) {
  if (warned.has(service) || !Notification.isSupported()) return;
  warned.add(service);
  const n = new Notification({ title: `${PROVIDERS[service].name} balance is low`, body: `${Math.floor(balance)} credits left, under your alert of ${threshold}. Open Settings, Spend to top up.` });
  n.on('click', () => { win?.show(); win?.webContents.executeJavaScript("location.hash = '#/settings/spend'"); });
  n.show();
}

app.whenReady().then(async () => {
  if (!primary) return;
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
  const { port } = await startApp({
    dataDir: path.join(app.getPath('userData'), 'library'),
    keepAwake: (() => { let id = null; return (on) => { if (on && id == null) id = powerSaveBlocker.start('prevent-app-suspension'); if (!on && id != null) { powerSaveBlocker.stop(id); id = null; } }; })(),
    defaultOutputRoot: suggestedOutputRoot(), // E:\Claude Stuff\car-360-pipeline\handoff on Tyrone's PC
    keyStore,
    // Looks for a newer release on GitHub; Download links open in the browser through the window-open handler below.
    ...updateOptions(process.env),
    onLowBalance: notifyLow,
    // Blender runs the render script as a separate program, so it can't be read from inside app.asar.
    // The three.js addons ship next to it because electron-builder leaves dependencies' examples/ folders out.
    ...(app.isPackaged && {
      blenderScript: path.join(process.resourcesPath, 'render', 'blender_turntable.py'),
      threeAddons: path.join(process.resourcesPath, 'three', 'examples', 'jsm'),
      hdriDir: path.join(process.resourcesPath, 'hdri'), // Blender reads the built-in HDRIs from here
    }),
  });
  console.log(`Flatform server on 127.0.0.1:${port}`);
  createWindow(port);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(port); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
