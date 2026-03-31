const { app, BrowserWindow, ipcMain } = require('electron');

// Remove Chromium's autoplay block so AudioContext works after async TTS inference
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,   // Hidden until the renderer confirms the backend is ready
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile('src/index.html');
  // win.webContents.openDevTools();

  win.on('closed', () => { win = null; });
}

// Renderer sends this once GET /api/ready returns true
ipcMain.on('backend-ready', () => {
  if (win) win.show();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});