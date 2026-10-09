const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * BiletAI desktop: client/index.html in its own window. The app only talks to the BiletAI
 * server (config.json -> serverUrl); it holds no API keys, so nothing secret ships here.
 */
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
// The installer carries client/ as a resource; in development the repo's copy is used.
const clientDir = app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(__dirname, '..', 'client');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 900, minWidth: 380, minHeight: 560,
    title: 'BiletAI',
    icon: path.join(__dirname, '..', 'assets', 'app.png'), // development; the installer embeds app.ico
    autoHideMenuBar: true,
    // Match the theme so the window doesn't flash white (light) or navy (dark) on start.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1020' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(clientDir, 'index.html'));

  // Web links open in the browser; the window itself never leaves the app.
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) { e.preventDefault(); external(url); }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.on('biletai:config', (e) => { e.returnValue = { serverUrl: config.serverUrl || '' }; });

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
