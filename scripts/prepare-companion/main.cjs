const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 1200,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[prep]', message);
  });
  win.on('closed', () => app.quit());
  win.loadFile(path.join(__dirname, 'prep.html')).catch((error) => {
    console.error('[prep] load failed', error);
    app.exit(1);
  });
});
